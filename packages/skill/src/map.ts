// `srev map …`: evidence for component inference, the dry-run fidelity
// check, submit and read, as served by /api/sessions/:id/map.
import { readFileSync } from "node:fs";
import { openInBrowser } from "./api.js";

export interface MapCheckIssue {
  rule: string;
  message: string;
  where?: string[];
}
export interface MapCheckReport {
  ok: boolean;
  coverage: { references: number; covered: number; undeclared: number };
  issues: MapCheckIssue[];
  unclaimedFiles: { component: string | null; files: string[] }[];
  unattributedReferences: number;
  utilities: { id: string; references: number }[];
  typeDependencies: { from: string; to: string; count: number; symbols: string[] }[];
  gaps: string[];
}
export interface MapEvidence {
  scope: string;
  full: boolean;
  tree: { path: string; files: number }[];
  roots: { language: string; root: string }[];
  manifest?: { id: string; paths: string[]; description?: string }[];
  candidates: { id: string; files: number }[];
  matrix: { from: string; to: string; references: number }[];
  surfaces: { candidate: string; symbols: number; groups: { usedBy: string[]; symbols: string[] }[] }[];
  signals: {
    implementations: { type: string; file: string; implementations: string[] }[];
    barrels: { file: string; exports: { from: string; names: string[] }[] }[];
    headers: { file: string; comment: string }[];
    entryPoints: { file: string; reason: string }[];
    registrations: { file: string; line: number; text: string }[];
  };
  gaps: string[];
}
interface StoredMap {
  model: unknown;
  map: { report: MapCheckReport };
  headSha: string;
  createdAt: number;
  stale?: boolean;
  staleReason?: string;
}

type Flags = Record<string, string | boolean>;
type MapCommandResult = { json: unknown; pretty?: string };

export function mapUrl(base: string, sessionId: string, level?: string): string {
  return `${base}/?session=${encodeURIComponent(sessionId)}&view=map${level ? `&level=${encodeURIComponent(level)}` : ""}`;
}

async function request(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  if (!res.ok && res.status !== 422) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return { status: res.status, body: await res.json() };
}

const mapPath = (base: string, sessionId: string) => `${base}/api/sessions/${encodeURIComponent(sessionId)}/map`;

export async function getMapEvidence(
  base: string,
  sessionId: string,
  opts: { within?: string; full?: boolean },
): Promise<MapEvidence> {
  const query = new URLSearchParams();
  if (opts.within) query.set("within", opts.within);
  if (opts.full) query.set("full", "1");
  const qs = query.size ? `?${query}` : "";
  return (await request(`${mapPath(base, sessionId)}/evidence${qs}`)).body as MapEvidence;
}

export async function checkMap(base: string, sessionId: string, model: unknown): Promise<MapCheckReport> {
  const { body } = await request(`${mapPath(base, sessionId)}/check`, { method: "POST", body: JSON.stringify(model) });
  return (body as { report: MapCheckReport }).report;
}

export async function submitMap(
  base: string,
  sessionId: string,
  model: unknown,
): Promise<{ ok: boolean; report: MapCheckReport }> {
  const { status, body } = await request(mapPath(base, sessionId), { method: "PUT", body: JSON.stringify(model) });
  return { ok: status === 200, report: (body as { report: MapCheckReport }).report };
}

export async function getMap(base: string, sessionId: string): Promise<StoredMap> {
  return (await request(mapPath(base, sessionId))).body as StoredMap;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function prettyReport(report: MapCheckReport): string {
  return [
    report.ok ? "fidelity check: passed" : `fidelity check: FAILED (${plural(report.issues.length, "issue")})`,
    `coverage: ${report.coverage.covered}/${report.coverage.references} cross-component references (${report.coverage.undeclared} undeclared)`,
    ...report.issues.map((i) => [`  [${i.rule}] ${i.message}`, ...(i.where ?? []).map((w) => `      ${w}`)].join("\n")),
    ...report.unclaimedFiles.map(
      (u) => `unclaimed files ${u.component ? `under ${u.component}` : "in no component"}: ${u.files.join(", ")}`,
    ),
    `unattributed references: ${report.unattributedReferences}`,
    ...report.utilities.map((u) => `utility ${u.id} hides ${plural(u.references, "reference")}`),
    ...report.typeDependencies.map((t) => `type-only: ${t.from} -> ${t.to} (${t.count}: ${t.symbols.join(", ")})`),
    ...report.gaps.map((g) => `! ${g}`),
  ].join("\n");
}

export function prettyEvidence(e: MapEvidence): string {
  return [
    `scope: ${e.scope || "."} (${e.full ? "full" : "brief"})`,
    "candidates:",
    ...e.candidates.map((c) => `  ${c.id} (${plural(c.files, "file")})`),
    "references:",
    ...e.matrix.map((m) => `  ${m.from} -> ${m.to}: ${m.references}`),
    ...e.surfaces.flatMap((s) => [
      `surface of ${s.candidate} (${plural(s.symbols, "symbol")}):`,
      ...s.groups.map((g) => `  used by ${g.usedBy.join(", ")}: ${g.symbols.join(", ")}`),
    ]),
    "headers:",
    ...e.signals.headers.map((h) => `  ${h.file}: ${h.comment}`),
    "registrations:",
    ...e.signals.registrations.map((r) => `  ${r.file}:${r.line} ${r.text}`),
    ...e.gaps.map((g) => `! ${g}`),
  ].join("\n");
}

function flag(flags: Flags, name: string): string {
  const v = flags[name];
  if (typeof v !== "string" || v === "") throw new Error(`missing required flag --${name}`);
  return v;
}

function readModel(path: string): unknown {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`model file ${path} is not valid JSON: ${(e as Error).message}`, { cause: e });
  }
}

async function evidenceCommand(base: string, flags: Flags): Promise<MapCommandResult> {
  const within = typeof flags.within === "string" ? flags.within : undefined;
  const evidence = await getMapEvidence(base, flag(flags, "session"), {
    ...(within ? { within } : {}),
    full: !!flags.full,
  });
  return { json: evidence, pretty: prettyEvidence(evidence) };
}

async function checkCommand(base: string, flags: Flags): Promise<MapCommandResult> {
  const sessionId = flag(flags, "session");
  const report = await checkMap(base, sessionId, readModel(flag(flags, "model")));
  if (!report.ok) process.exitCode = 1;
  return { json: { report }, pretty: prettyReport(report) };
}

async function submitCommand(base: string, flags: Flags): Promise<MapCommandResult> {
  const sessionId = flag(flags, "session");
  const { ok, report } = await submitMap(base, sessionId, readModel(flag(flags, "model")));
  const url = mapUrl(base, sessionId);
  if (!ok) {
    process.exitCode = 1;
    return { json: { ok, report }, pretty: `map not stored\n${prettyReport(report)}` };
  }
  if (flags.open) openInBrowser(url);
  return { json: { ok, url, report }, pretty: `map stored: ${url}\n${prettyReport(report)}` };
}

async function getCommand(base: string, flags: Flags): Promise<MapCommandResult> {
  const sessionId = flag(flags, "session");
  const stored = await getMap(base, sessionId);
  const url = mapUrl(base, sessionId);
  const staleness = stored.stale === undefined ? {} : { stale: stored.stale };
  const json = {
    model: stored.model,
    url,
    ...staleness,
    ...(stored.staleReason ? { staleReason: stored.staleReason } : {}),
    report: stored.map.report,
  };
  return {
    json,
    pretty: `${url}${stored.stale ? ` (stale: ${stored.staleReason})` : ""}\n${prettyReport(stored.map.report)}`,
  };
}

/** `srev map <sub>` handlers keyed by the full command name. */
export const MAP_COMMANDS: Record<string, (base: string, flags: Flags) => Promise<MapCommandResult>> = {
  "map evidence": evidenceCommand,
  "map check": checkCommand,
  "map submit": submitCommand,
  "map get": getCommand,
};
