#!/usr/bin/env node
// packages/skill/src/cli.ts — `srev`: agent-facing CLI over the review hub.
// JSON on stdout for agent consumption; --pretty for humans. Thin wrapper over
// the HTTP API (api.ts) and server lifecycle (serve.ts) — never SQLite.
import { readFileSync } from "node:fs";
import {
  DEFAULT_BASE_URL,
  briefContext,
  compactContext,
  createSession,
  defaultPartition,
  deleteSession,
  exportComments,
  getChanges,
  getFlows,
  getNodeDiff,
  getNodes,
  getSessionInfo,
  launchUI,
  listSessions,
  parsePlanFile,
  resolveBaseAlias,
  resolvePlanRefs,
  shutdownHub,
  suggestMerges,
  uiUrl,
  writePlan,
  type Coverage,
  type UnitInput,
} from "./api.js";
import { computeStatus, waitConditionMet, type SessionStatus } from "./status.js";
import { ensureServer } from "./serve.js";
import { gcRepo, gcSweep } from "./gc.js";

const USAGE = `usage:
  srev serve [--repo <path>] [--port N]
  srev session create --branch <b> --base <ref|empty> [--open]
  srev session list
  srev session delete --session <id>
  srev context --session <id> [--brief|--full]
  srev plan --session <id> (--auto | --units <file.json>) [--open]
  srev diff --session <id> --node <stableId>
  srev status --session <id>
  srev comments --session <id>
  srev wait --session <id> [--until reviewed|commented] [--interval sec] [--timeout sec]
  srev gc [--repo <path>] [--all]
  srev shutdown
global flags: --port N (hub port), --pretty (human-readable output)`;

const BOOL_FLAGS = new Set(["auto", "open", "pretty", "all", "full", "brief"]);

export interface CliArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (tok.startsWith("--")) {
      const name = tok.slice(2);
      if (BOOL_FLAGS.has(name)) flags[name] = true;
      else {
        flags[name] = argv[++i] ?? "";
      }
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
    ...(s.overview ? [`overview: ${s.overview.length > 100 ? s.overview.slice(0, 100) + "…" : s.overview}`] : []),
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
  const baseRef = resolveBaseAlias(required(flags, "base"));
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

async function cmdSessionList(base: string): Promise<CommandResult> {
  const { sessions } = await listSessions(base);
  return {
    json: { sessions },
    pretty:
      sessions.length === 0
        ? "no sessions"
        : sessions
            .map(
              (s) =>
                `${s.id} (${s.status}) — ${s.branch} vs ${s.baseRef}, created ${new Date(s.createdAt).toISOString()}`,
            )
            .join("\n"),
  };
}

async function cmdSessionDelete(base: string, flags: Record<string, string | boolean>): Promise<CommandResult> {
  const sessionId = required(flags, "session");
  const result = await deleteSession(base, sessionId);
  return { json: result, pretty: `deleted session ${result.deleted}` };
}

// Cleanup is file-level on purpose: gc exists for state whose hub/repo is
// already gone. It stops the hub first so SQLite WAL files are never removed
// under a live process.
async function cmdGc(base: string, flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.all) {
    const dataDir = process.env.SREV_DATA_DIR;
    if (!dataDir) throw new Error("srev gc --all needs SREV_DATA_DIR (plugin mode); use srev gc --repo <path> instead");
    const result = gcSweep(dataDir);
    return {
      json: result,
      pretty: [
        ...result.swept.map((s) => `swept ${s.key} (${s.repoRoot}):\n${s.removed.map((p) => `  - ${p}`).join("\n")}`),
        ...result.skipped.map((s) => `skipped ${s.key}: ${s.reason}`),
        ...(result.swept.length + result.skipped.length === 0 ? ["nothing to sweep"] : []),
      ].join("\n"),
    };
  }
  const repo = typeof flags.repo === "string" ? flags.repo : process.cwd();
  const result = await gcRepo(repo, base);
  return {
    json: result,
    pretty: [
      `repo: ${result.repoRoot}`,
      result.hubStopped ? "hub stopped" : "no hub running for this repo",
      ...(result.removed.length ? ["removed:", ...result.removed.map((p) => `  - ${p}`)] : ["nothing to remove"]),
    ].join("\n"),
  };
}

// Stop the hub over HTTP — the CLI counterpart of POST /api/shutdown, so
// cleanup never needs a hand-rolled curl.
async function cmdShutdown(base: string): Promise<CommandResult> {
  const result = await shutdownHub(base);
  return { json: result, pretty: `hub stopping${result.pid ? ` (pid ${result.pid})` : ""}` };
}

/** Human-scannable rendering of the brief context — the table a planner would
 *  otherwise write a throwaway script to produce. */
export function prettyBrief(brief: ReturnType<typeof briefContext>, commitSubjects?: string[]): string {
  return [
    ...(commitSubjects?.length ? ["commits:", ...commitSubjects.map((s) => `  ${s}`)] : []),
    `flows (${brief.flows.length} affected):`,
    ...brief.flows.map((f) => `  [${f.id}] ${f.name} (${f.changedCount} changed) — ${f.entry}`),
    ...(brief.mergeSuggestions.length ? ["merge suggestions:"] : []),
    ...brief.mergeSuggestions.map((s) => `  [group ${s.group}] flows ${s.flowIds.join("+")} — ${s.names.join(", ")}`),
    ...(brief.orphanGroups.length ? ["orphan groups:"] : []),
    ...brief.orphanGroups.map((g) => `  ${g.dir} — ${g.files.join(", ")}`),
    `changes (${brief.changes.length}):`,
    ...brief.changes.map((c) => `  ${c.file}:${c.lines} ${c.label} (${c.kind}, ${c.status} +${c.added}/-${c.removed})`),
  ].join("\n");
}

// Planning context for LLM-authored plans: affected flows (no step arrays),
// orphans reduced to plan-referencable fields, and compact per-node change
// summaries (kind, file, lines, +/- counts, signature) — not diff bodies.
// `--brief` goes further and drops stableIds entirely (numeric flow ids +
// file paths are enough to author a plan via flowIds/mergeGroup/orphanFiles);
// `--full` restores the complete dump (all flows with steps, full orphan nodes).
async function cmdContext(base: string, flags: Record<string, string | boolean>): Promise<CommandResult> {
  const sessionId = required(flags, "session");
  const [{ flows, orphans }, { changes, commitSubjects }] = await Promise.all([
    getFlows(base, sessionId),
    getChanges(base, sessionId),
  ]);
  const subjects = commitSubjects === undefined ? {} : { commitSubjects };
  if (flags.full) return { json: { sessionId, ...subjects, flows, orphans, changes } };
  if (flags.brief) {
    const brief = briefContext(flows, orphans, changes);
    return { json: { sessionId, ...subjects, ...brief }, pretty: prettyBrief(brief, commitSubjects) };
  }
  const compact = compactContext(flows, orphans);
  // Precomputed merge guideline (shared changed ids >= half the smaller flow's
  // set) so the planner spends judgment on labels/order, not set arithmetic.
  return {
    json: {
      sessionId,
      ...subjects,
      flows: compact.flows,
      mergeSuggestions: suggestMerges(compact.flows),
      orphanGroups: compact.orphanGroups,
      changes,
    },
  };
}

/** Shape the plan-submit response for output. `unassigned` is always present
 *  ([] at full coverage) so scripted consumers get a stable response shape. */
export function planOutput(result: Awaited<ReturnType<typeof writePlan>>): {
  coverage: Coverage;
  overview?: string;
  unassigned: { stableId: string; label: string; file: string }[];
  units: { label: string; kind: string; auto: boolean; members: number; attached: number }[];
} {
  return {
    coverage: result.coverage,
    ...(result.overview ? { overview: result.overview } : {}),
    // Leftovers by stableId so a planner can author orphan-units for them and
    // re-submit without re-fetching the session.
    unassigned: result.unassigned ?? [],
    units: result.units.map((u) => ({
      label: u.label,
      kind: u.kind,
      auto: u.auto,
      members: u.memberStableIds.length,
      attached: (u.attached ?? []).filter((m) => m.counted).length,
    })),
  };
}

async function cmdPlan(base: string, flags: Record<string, string | boolean>): Promise<CommandResult> {
  const sessionId = required(flags, "session");
  let units: UnitInput[];
  let overview: string | undefined;
  if (flags.auto) {
    const { flows, orphans } = await getFlows(base, sessionId);
    units = defaultPartition(flows, orphans);
  } else if (typeof flags.units === "string") {
    ({ units, overview } = parsePlanFile(readFileSync(flags.units, "utf8")));
    // Numeric refs (flowIds / mergeGroup) resolve against the same compacted
    // flows + merge suggestions `srev context` printed, so the numbers a
    // planner read are the numbers that resolve here.
    if (units.some((u) => u.kind === "flow" && (u.flowIds !== undefined || u.mergeGroup !== undefined))) {
      const { flows, orphans } = await getFlows(base, sessionId);
      const compact = compactContext(flows, orphans);
      units = resolvePlanRefs(units, compact.flows, suggestMerges(compact.flows));
    }
  } else {
    throw new Error(`plan needs --auto or --units <file.json>\n${USAGE}`);
  }
  const result = await writePlan(base, sessionId, units, overview);
  if (flags.open) launchUI(base, sessionId);
  const out = planOutput(result);
  const unassigned = out.unassigned;
  return {
    json: out,
    pretty: [
      `coverage: ${out.coverage.covered}/${out.coverage.changedTotal} assigned, ${out.coverage.unassigned} unassigned`,
      ...(out.overview ? [`overview: ${out.overview}`] : []),
      ...unassigned.map((n) => `  unassigned: ${n.label} — ${n.file} (${n.stableId})`),
      ...out.units.map(
        (u) =>
          `  ${u.label}${u.auto ? " (auto)" : ""} — ${u.kind}, ${u.members} member(s)${u.attached ? `, ${u.attached} attached` : ""}`,
      ),
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
    comments: exported.comments.map((c) =>
      c.scope === "session" ? c : { ...c, reviewStatus: statusByNode.get(c.nodeId) ?? "unknown" },
    ),
  };
  return {
    json: out,
    pretty:
      out.comments.length === 0
        ? "no comments"
        : out.comments
            .map((c) => {
              if (c.scope === "session") return `[review-wide]\n  ${c.text.replace(/\n/g, "\n  ")}`;
              const where = c.anchor
                ? `${c.file}:${c.anchor.startLine}-${c.anchor.endLine}`
                : `${c.file}:${c.startLine}-${c.endLine}`;
              return `${where} (${c.label}, ${c.reviewStatus})\n  ${c.text.replace(/\n/g, "\n  ")}`;
            })
            .join("\n"),
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
      return {
        json,
        pretty: `condition '${until}' met (${exported.comments.length} comment(s))\n${prettyStatus(status)}`,
      };
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
  const [majorText, minorText] = process.versions.node.split(".");
  const major = Number(majorText);
  const minor = Number(minorText);
  if (major > 22 || (major === 22 && minor >= 13)) return;
  throw new Error(`srev requires Node >= 22.13 (found ${process.versions.node})`);
}

export async function runCli(argv: string[]): Promise<void> {
  checkNodeVersion();
  const { command, flags } = parseCliArgs(argv);
  const base = baseUrlFor(flags);

  let result: CommandResult;
  switch (command) {
    case "serve":
      result = await cmdServe(flags);
      break;
    case "session create":
      result = await cmdSessionCreate(base, flags);
      break;
    case "session list":
      result = await cmdSessionList(base);
      break;
    case "session delete":
      result = await cmdSessionDelete(base, flags);
      break;
    case "gc":
      result = await cmdGc(base, flags);
      break;
    case "shutdown":
      result = await cmdShutdown(base);
      break;
    case "context":
      result = await cmdContext(base, flags);
      break;
    case "plan":
      result = await cmdPlan(base, flags);
      break;
    case "diff":
      result = await cmdDiff(base, flags);
      break;
    case "status":
      result = await cmdStatus(base, flags);
      break;
    case "comments":
      result = await cmdComments(base, flags);
      break;
    case "wait":
      result = await cmdWait(base, flags);
      break;
    case "":
      throw new Error(USAGE);
    default:
      throw new Error(`unknown command: ${command}\n${USAGE}`);
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
      ? {
          error: `review hub not running at ${baseUrlFor(parseCliArgs(process.argv.slice(2)).flags)}`,
          hint: "run: srev serve",
        }
      : { error: e instanceof Error ? e.message : String(e) };
    console.error(JSON.stringify(err));
    process.exitCode = process.exitCode || 1;
  });
}
