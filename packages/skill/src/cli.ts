#!/usr/bin/env node
// packages/skill/src/cli.ts — `crw`: agent-facing CLI over the review hub.
// JSON on stdout for agent consumption; --pretty for humans. Thin wrapper over
// the HTTP API (api.ts) and server lifecycle (serve.ts) — never SQLite.
import { readFileSync } from "node:fs";
import {
  DEFAULT_BASE_URL, createSession, defaultPartition, exportComments, getChanges, getFlows,
  getNodeDiff, getNodes, getSessionInfo, launchUI, uiUrl, writePlan, type UnitInput,
} from "./api.js";
import { computeStatus, waitConditionMet, type SessionStatus } from "./status.js";
import { ensureServer } from "./serve.js";

const USAGE = `usage:
  crw serve [--repo <path>] [--port N]
  crw session create --branch <b> --base <ref> [--open]
  crw context --session <id>
  crw plan --session <id> (--auto | --units <file.json>) [--open]
  crw diff --session <id> --node <stableId>
  crw status --session <id>
  crw comments --session <id>
  crw wait --session <id> [--until reviewed|commented] [--interval sec] [--timeout sec]
global flags: --port N (hub port), --pretty (human-readable output)`;

const BOOL_FLAGS = new Set(["auto", "open", "pretty"]);

export interface CliArgs { command: string; flags: Record<string, string | boolean>; }

export function parseCliArgs(argv: string[]): CliArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const name = tok.slice(2);
      if (BOOL_FLAGS.has(name)) flags[name] = true;
      else { flags[name] = argv[++i] ?? ""; }
    } else {
      positionals.push(tok);
    }
  }
  return { command: positionals.join(" "), flags };
}

function baseUrlFor(flags: Record<string, string | boolean>): string {
  return typeof flags.port === "string" ? `http://127.0.0.1:${flags.port}` : DEFAULT_BASE_URL;
}

function required(flags: Record<string, string | boolean>, name: string): string {
  const v = flags[name];
  if (typeof v !== "string" || v === "") throw new Error(`missing required flag --${name}\n${USAGE}`);
  return v;
}

async function fetchStatus(base: string, sessionId: string): Promise<SessionStatus> {
  const [info, { nodes }, { flows }] = await Promise.all([
    getSessionInfo(base, sessionId),
    getNodes(base, sessionId),
    getFlows(base, sessionId),
  ]);
  return computeStatus(info, nodes, flows);
}

function prettyStatus(s: SessionStatus): string {
  const lines = [
    `session ${s.sessionId} (${s.sessionStatus})${s.stale ? ` — STALE: ${s.staleReason}` : ""}`,
    `coverage: ${s.coverage.covered}/${s.coverage.changedTotal} assigned, ${s.coverage.unassigned} unassigned`,
    ...s.units.map((u) => `  [${u.reviewed}/${u.total}] ${u.label}${u.auto ? " (auto)" : ""} — ${u.kind}`),
  ];
  if (s.unreviewed.length > 0) {
    lines.push(`unreviewed (${s.unreviewed.length}):`);
    lines.push(...s.unreviewed.map((n) => `  ${n.label} — ${n.file}`));
  }
  return lines.join("\n");
}

type CommandResult = { json: unknown; pretty?: string };

async function cmdServe(flags: Record<string, string | boolean>): Promise<CommandResult> {
  const repo = typeof flags.repo === "string" ? flags.repo : process.cwd();
  const port = typeof flags.port === "string" ? Number(flags.port) : 3456;
  const result = await ensureServer({ repo, port });
  return {
    json: result,
    pretty: `hub ${result.reused ? "reused" : "started"} at ${result.baseUrl} (pid ${result.pid}, provider ${result.provider})\nrepo: ${result.repoRoot}`,
  };
}

async function cmdSessionCreate(base: string, flags: Record<string, string | boolean>): Promise<CommandResult> {
  const branch = typeof flags.branch === "string" ? flags.branch : "HEAD";
  const baseRef = required(flags, "base");
  const { session } = await createSession(base, branch, baseRef);
  const [{ nodes }, { flows }] = await Promise.all([getNodes(base, session.id), getFlows(base, session.id)]);
  if (flags.open) launchUI(base, session.id);
  const out = {
    sessionId: session.id,
    uiUrl: uiUrl(base, session.id),
    changedNodes: nodes.filter((n) => n.changeStatus === "changed").length,
    totalNodes: nodes.length,
    affectedFlows: flows.filter((f) => f.affected).length,
    totalFlows: flows.length,
    // Always present (even when empty) so the agent cannot miss degradation
    // warnings — it must relay these to the user.
    indexWarnings: session.indexWarnings ?? [],
  };
  return {
    json: out,
    pretty: [
      `session ${out.sessionId}`,
      `ui: ${out.uiUrl}`,
      `nodes: ${out.changedNodes} changed / ${out.totalNodes} total; flows: ${out.affectedFlows} affected / ${out.totalFlows} total`,
      ...(out.indexWarnings.length ? ["index warnings:", ...out.indexWarnings.map((w: string) => `  ! ${w}`)] : []),
    ].join("\n"),
  };
}

// Planning context for LLM-authored plans: flows + orphans + compact per-node
// change summaries (kind, file, lines, +/- counts, signature) — not diff bodies.
async function cmdContext(base: string, flags: Record<string, string | boolean>): Promise<CommandResult> {
  const sessionId = required(flags, "session");
  const [{ flows, orphans }, { changes }] = await Promise.all([
    getFlows(base, sessionId),
    getChanges(base, sessionId),
  ]);
  return { json: { sessionId, flows, orphans, changes } };
}

async function cmdPlan(base: string, flags: Record<string, string | boolean>): Promise<CommandResult> {
  const sessionId = required(flags, "session");
  let units: UnitInput[];
  if (flags.auto) {
    const { flows, orphans } = await getFlows(base, sessionId);
    units = defaultPartition(flows, orphans);
  } else if (typeof flags.units === "string") {
    units = JSON.parse(readFileSync(flags.units, "utf8")) as UnitInput[];
  } else {
    throw new Error(`plan needs --auto or --units <file.json>\n${USAGE}`);
  }
  const result = await writePlan(base, sessionId, units);
  if (flags.open) launchUI(base, sessionId);
  const out = {
    coverage: result.coverage,
    units: result.units.map((u) => ({
      label: u.label, kind: u.kind, auto: u.auto, members: u.memberStableIds.length,
      attached: (u.attached ?? []).filter((m) => m.counted).length,
    })),
  };
  return {
    json: out,
    pretty: [
      `coverage: ${out.coverage.covered}/${out.coverage.changedTotal} assigned, ${out.coverage.unassigned} unassigned`,
      ...out.units.map((u) =>
        `  ${u.label}${u.auto ? " (auto)" : ""} — ${u.kind}, ${u.members} member(s)${u.attached ? `, ${u.attached} attached` : ""}`),
    ].join("\n"),
  };
}

async function cmdDiff(base: string, flags: Record<string, string | boolean>): Promise<CommandResult> {
  const sessionId = required(flags, "session");
  const stableId = required(flags, "node");
  const { nodes } = await getNodes(base, sessionId);
  const node = nodes.find((n) => n.stableId === stableId);
  if (!node) throw new Error(`no node with stableId ${stableId} in session ${sessionId}`);
  return { json: await getNodeDiff(base, sessionId, node.id) };
}

async function cmdStatus(base: string, flags: Record<string, string | boolean>): Promise<CommandResult> {
  const status = await fetchStatus(base, required(flags, "session"));
  return { json: status, pretty: prettyStatus(status) };
}

async function cmdComments(base: string, flags: Record<string, string | boolean>): Promise<CommandResult> {
  const sessionId = required(flags, "session");
  const [exported, { nodes }] = await Promise.all([exportComments(base, sessionId), getNodes(base, sessionId)]);
  const statusByNode = new Map(nodes.map((n) => [n.id, n.reviewStatus]));
  const out = {
    ...exported,
    comments: exported.comments.map((c) => ({ ...c, reviewStatus: statusByNode.get(c.nodeId) ?? "unknown" })),
  };
  return {
    json: out,
    pretty: out.comments.length === 0
      ? "no comments"
      : out.comments.map((c) => {
          const where = c.anchor ? `${c.file}:${c.anchor.startLine}-${c.anchor.endLine}` : `${c.file}:${c.startLine}-${c.endLine}`;
          return `${where} (${c.label}, ${c.reviewStatus})\n  ${c.text.replace(/\n/g, "\n  ")}`;
        }).join("\n"),
  };
}

async function cmdWait(base: string, flags: Record<string, string | boolean>): Promise<CommandResult> {
  const sessionId = required(flags, "session");
  const until = flags.until === "commented" ? "commented" : "reviewed";
  const intervalMs = (typeof flags.interval === "string" ? Number(flags.interval) : 5) * 1000;
  const timeoutMs = (typeof flags.timeout === "string" ? Number(flags.timeout) : 1800) * 1000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [status, exported] = await Promise.all([fetchStatus(base, sessionId), exportComments(base, sessionId)]);
    if (waitConditionMet(until, status, exported.comments.length)) {
      const json = { until, met: true, commentCount: exported.comments.length, status };
      return { json, pretty: `condition '${until}' met (${exported.comments.length} comment(s))\n${prettyStatus(status)}` };
    }
    if (Date.now() >= deadline) {
      process.exitCode = 2;
      const json = { until, met: false, timedOut: true, commentCount: exported.comments.length, status };
      return { json, pretty: `timed out waiting for '${until}'\n${prettyStatus(status)}` };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** The server needs node:sqlite (unflagged since 22.13) — fail with a clear
 *  message instead of a cryptic module error on the spawned server. */
function checkNodeVersion(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 13)) return;
  throw new Error(`crw requires Node >= 22.13 (found ${process.versions.node})`);
}

export async function runCli(argv: string[]): Promise<void> {
  checkNodeVersion();
  const { command, flags } = parseCliArgs(argv);
  const base = baseUrlFor(flags);

  let result: CommandResult;
  switch (command) {
    case "serve": result = await cmdServe(flags); break;
    case "session create": result = await cmdSessionCreate(base, flags); break;
    case "context": result = await cmdContext(base, flags); break;
    case "plan": result = await cmdPlan(base, flags); break;
    case "diff": result = await cmdDiff(base, flags); break;
    case "status": result = await cmdStatus(base, flags); break;
    case "comments": result = await cmdComments(base, flags); break;
    case "wait": result = await cmdWait(base, flags); break;
    case "": throw new Error(USAGE);
    default: throw new Error(`unknown command: ${command}\n${USAGE}`);
  }
  console.log(flags.pretty && result.pretty ? result.pretty : JSON.stringify(result.json, null, 2));
}

function isConnRefused(e: unknown): boolean {
  const cause = (e as { cause?: { code?: string } })?.cause;
  return cause?.code === "ECONNREFUSED" || cause?.code === "ECONNRESET";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2)).catch((e: unknown) => {
    const err = isConnRefused(e)
      ? { error: `review hub not running at ${baseUrlFor(parseCliArgs(process.argv.slice(2)).flags)}`, hint: "run: crw serve" }
      : { error: e instanceof Error ? e.message : String(e) };
    console.error(JSON.stringify(err));
    process.exitCode = process.exitCode || 1;
  });
}
