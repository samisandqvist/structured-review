// `srev map …`: evidence for component inference, the dry-run fidelity
// check, submit and read, as served by /api/sessions/:id/map.
import { readFileSync } from "node:fs";
import { openInBrowser } from "./api.js";

interface MapCheckIssue {
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
/** The parts of a review map's change the CLI prints (see the hub's map/change.ts). */
export interface MapChangeSummary {
  baseSha: string;
  components: { id: string; items: number; files: number }[];
  addedComponents: string[];
  removedComponents: string[];
  crossings: { interface: string; requirer: string; status: string; added: unknown[]; removed: unknown[] }[];
  surfaces: { provider: string; requirers: string[]; symbol: string; references: number }[];
  touched: { interface: string; reasons: string[]; symbols: string[] }[];
  unmapped: { component: string | null; files: string[] }[];
}
export interface MapEvidence {
  /** Set in a review session: the evidence describes this base commit. */
  baseSha?: string;
  /** Set in a review session: files the change adds, which the base cannot show. */
  addedFiles?: string[];
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
  map: { report: MapCheckReport; change?: MapChangeSummary };
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

async function getMapEvidence(
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

async function checkMap(base: string, sessionId: string, model: unknown): Promise<MapCheckReport> {
  const { body } = await request(`${mapPath(base, sessionId)}/check`, { method: "POST", body: JSON.stringify(model) });
  return (body as { report: MapCheckReport }).report;
}

export async function submitMap(
  base: string,
  sessionId: string,
  model: unknown,
): Promise<{ ok: boolean; report: MapCheckReport; change?: MapChangeSummary }> {
  const { status, body } = await request(mapPath(base, sessionId), { method: "PUT", body: JSON.stringify(model) });
  const { report, change } = body as { report: MapCheckReport; change?: MapChangeSummary };
  return { ok: status === 200, report, ...(change ? { change } : {}) };
}

async function getMap(base: string, sessionId: string): Promise<StoredMap> {
  return (await request(mapPath(base, sessionId))).body as StoredMap;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function prettyReport(report: MapCheckReport): string {
  return [
    report.ok ? "fidelity check: passed" : `fidelity check: FAILED (${plural(report.issues.length, "issue")})`,
    `coverage: ${report.coverage.covered}/${report.coverage.references} cross-component references are call sites (${plural(report.coverage.undeclared, "undeclared call site")})`,
    ...report.issues.map((i) => [`  [${i.rule}] ${i.message}`, ...(i.where ?? []).map((w) => `      ${w}`)].join("\n")),
    ...report.unclaimedFiles.map(
      (u) => `unclaimed files ${u.component ? `under ${u.component}` : "in no component"}: ${u.files.join(", ")}`,
    ),
    `unattributed references: ${report.unattributedReferences}`,
    ...report.utilities.map((u) => `utility ${u.id} hides ${plural(u.references, "reference")}`),
    ...report.typeDependencies.map((t) => `type-only: ${t.from} -> ${t.to} (${t.count}: ${t.symbols.join(", ")})`),
    ...(report.gaps.length ? report.gaps.map((g) => `! ${g}`) : ["gaps: none"]),
  ].join("\n");
}

const short = (sha: string) => sha.slice(0, 7);

export function prettyChange(change: MapChangeSummary): string {
  const sites = (n: number) => plural(n, "call site");
  const crossing = (c: MapChangeSummary["crossings"][number]) =>
    c.status === "changed"
      ? `  changed dependency: ${c.requirer} -> ${c.interface} (+${c.added.length} / -${c.removed.length} call sites)`
      : `  ${c.status} dependency: ${c.requirer} -> ${c.interface} (${sites(c.status === "new" ? c.added.length : c.removed.length)})`;
  return [
    `change against base ${short(change.baseSha)}`,
    `  changed components: ${change.components.map((c) => `${c.id} (${plural(c.items, "item")}, ${plural(c.files, "file")})`).join(", ") || "none"}`,
    ...(change.addedComponents.length ? [`  added components: ${change.addedComponents.join(", ")}`] : []),
    ...(change.removedComponents.length ? [`  removed components: ${change.removedComponents.join(", ")}`] : []),
    ...change.crossings.map(crossing),
    ...change.surfaces.map(
      (s) =>
        `  new surface: ${s.symbol} of ${s.provider}, used by ${s.requirers.join(", ")} (${plural(s.references, "reference")})`,
    ),
    ...change.touched.map(
      (t) =>
        `  contract touched: ${t.interface} (${t.reasons.join(", ")}${t.symbols.length ? `: ${t.symbols.join(", ")}` : ""})`,
    ),
    ...change.unmapped.map(
      (u) => `  not placed ${u.component ? `under ${u.component}` : "in any component"}: ${u.files.join(", ")}`,
    ),
  ].join("\n");
}

export function prettyEvidence(e: MapEvidence): string {
  return [
    `scope: ${e.scope || "."} (${e.full ? "full" : "brief"})${e.baseSha ? `, base ${short(e.baseSha)}` : ""}`,
    "candidates:",
    ...e.candidates.map((c) => `  ${c.id} (${plural(c.files, "file")})`),
    "references:",
    ...e.matrix.map((m) => `  ${m.from} -> ${m.to}: ${m.references}`),
    ...e.surfaces.flatMap((s) => [
      `surface of ${s.candidate} (${plural(s.symbols, "symbol")}):`,
      ...s.groups.map((g) => `  used by ${g.usedBy.join(", ")}: ${g.symbols.join(", ")}`),
    ]),
    "(outside) = files outside the scope; run without --within to see them",
    "implementations:",
    ...e.signals.implementations.map((i) => `  ${i.type} (${i.file}): ${i.implementations.join(", ")}`),
    "barrels:",
    ...e.signals.barrels.flatMap((b) => b.exports.map((x) => `  ${b.file}: ${x.names.join(", ")} from ${x.from}`)),
    "entry points:",
    ...e.signals.entryPoints.map((p) => `  ${p.file}: ${p.reason}`),
    "headers:",
    ...e.signals.headers.map((h) => `  ${h.file}: ${h.comment}`),
    "registrations:",
    ...e.signals.registrations.map((r) => `  ${r.file}:${r.line} ${r.text}`),
    ...addedDirectories(e.addedFiles),
    ...(e.gaps.length ? e.gaps.map((g) => `! ${g}`) : ["gaps: none"]),
  ].join("\n");
}

/** The directories holding files a review adds, with their file counts. */
function addedDirectories(files: string[] = []): string[] {
  if (files.length === 0) return [];
  const dirs = new Map<string, number>();
  for (const file of files) {
    const dir = file.includes("/") ? `${file.slice(0, file.lastIndexOf("/"))}/` : ".";
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
  }
  const lines = [...dirs].sort(([a], [b]) => a.localeCompare(b)).map(([d, n]) => `  ${d} (${plural(n, "file")})`);
  return ["added by the change:", ...lines];
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
  const { ok, report, change } = await submitMap(base, sessionId, readModel(flag(flags, "model")));
  const url = mapUrl(base, sessionId);
  if (!ok) {
    process.exitCode = 1;
    return { json: { ok, report }, pretty: `map not stored\n${prettyReport(report)}` };
  }
  if (flags.open) openInBrowser(url);
  return {
    json: { ok, url, report, ...(change ? { change } : {}) },
    pretty: [`map stored: ${url}`, prettyReport(report), ...(change ? [prettyChange(change)] : [])].join("\n"),
  };
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
    ...(stored.map.change ? { change: stored.map.change } : {}),
  };
  return {
    json,
    pretty: [
      `${url}${stored.stale ? ` (stale: ${stored.staleReason})` : ""}`,
      prettyReport(stored.map.report),
      ...(stored.map.change ? [prettyChange(stored.map.change)] : []),
    ].join("\n"),
  };
}

/** `srev map <sub>` handlers keyed by the full command name. */
export const MAP_COMMANDS: Record<string, (base: string, flags: Flags) => Promise<MapCommandResult>> = {
  "map evidence": evidenceCommand,
  "map check": checkCommand,
  "map submit": submitCommand,
  "map get": getCommand,
};
