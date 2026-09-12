// packages/skill/src/api.ts — typed client for the review hub HTTP API.
// Every function takes the hub base URL explicitly; no SQLite access anywhere,
// so the CLI stays correct across schema migrations.
import { spawn } from "node:child_process";

export const DEFAULT_BASE_URL = process.env.CRW_SERVER_URL || "http://localhost:3456";

/** git's well-known empty tree; `crw session create --base empty` maps here,
 *  making the session a whole-repo review (diff from nothing). */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Base-ref conveniences: "empty" = the empty tree (whole-repo review). */
export function resolveBaseAlias(ref: string): string {
  return ref === "empty" ? EMPTY_TREE_SHA : ref;
}

export interface Session {
  id: string;
  branch: string;
  baseRef: string;
  status: string;
  createdAt: number;
  headSha?: string;
  indexWarnings?: string[];
  overview?: string;
}
export interface GraphNode {
  stableId: string;
  label: string;
  file: string;
  startLine: number;
  endLine: number;
  isEntryPoint: boolean;
  changeStatus: string;
}
export interface GraphEdge {
  sourceStableId: string;
  targetStableId: string;
  edgeType: string;
}
export interface ChangeSubgraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface FlowStep {
  stableId: string;
  label: string;
  file: string;
  startLine: number;
  endLine: number;
  isTest: boolean;
  depth: number;
  nodeId: string | null;
  changeStatus: string | null;
  reviewStatus: string | null;
}
export interface FlowDTO {
  id: number;
  name: string;
  affected: boolean;
  entryStableId: string;
  changedStableIds: string[];
  steps: FlowStep[];
}
export interface OrphanDTO {
  stableId: string;
  label: string;
  file: string;
  residualKind?: string | null;
}

/** Planning view of a session: affected flows without their step arrays,
 *  orphans reduced to what a plan references and grouped by directory (the
 *  triage a planner does anyway — docs vs configs vs code residuals). This is
 *  what an LLM planner needs to author units; the full flat dump is behind
 *  `crw context --full`. */
export function compactContext(
  flows: FlowDTO[],
  orphans: OrphanDTO[],
): {
  flows: { id: number; name: string; entryStableId: string; changedStableIds: string[] }[];
  orphanGroups: {
    dir: string;
    orphans: { stableId: string; label: string; file: string; residualKind?: string | null }[];
  }[];
} {
  const dirOf = (file: string) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".");
  const byDir = new Map<string, OrphanDTO[]>();
  for (const o of [...orphans].sort((a, b) => a.file.localeCompare(b.file))) {
    const dir = dirOf(o.file);
    byDir.set(dir, [...(byDir.get(dir) ?? []), o]);
  }
  return {
    flows: flows
      .filter((f) => f.affected)
      .map((f) => ({ id: f.id, name: f.name, entryStableId: f.entryStableId, changedStableIds: f.changedStableIds })),
    orphanGroups: [...byDir.keys()].sort().map((dir) => ({
      dir,
      orphans: byDir.get(dir)!.map((o) => ({
        stableId: o.stableId,
        label: o.label,
        file: o.file,
        ...(o.residualKind !== undefined ? { residualKind: o.residualKind } : {}),
      })),
    })),
  };
}

/** Per-node change summary as served by GET /:id/changes. */
export interface ChangeSummary {
  stableId: string;
  label: string;
  kind: string;
  file: string;
  startLine: number;
  endLine: number;
  status: string;
  added: number;
  removed: number;
  signature?: string | null;
}

/** Scannable planning view with no SCIP stableIds anywhere (`crw context
 *  --brief`): flows named by their numeric id + a short human entry, merge
 *  suggestions by group index + flow ids, orphan groups as directory + file
 *  list, changes without stableId/signature. With numeric plan refs
 *  (resolvePlanRefs) and orphanFiles globs this is everything plan authoring
 *  needs — the group indexes and flow ids here are exactly what `mergeGroup`
 *  and `flowIds` resolve against at plan submit. */
export function briefContext(
  flows: FlowDTO[],
  orphans: OrphanDTO[],
  changes: ChangeSummary[],
): {
  flows: { id: number; name: string; entry: string; changedCount: number }[];
  mergeSuggestions: { group: number; flowIds: number[]; names: string[] }[];
  orphanGroups: { dir: string; files: string[] }[];
  changes: {
    file: string;
    lines: string;
    label: string;
    kind: string;
    status: string;
    added: number;
    removed: number;
  }[];
} {
  const compact = compactContext(flows, orphans);
  const entryOf = new Map(
    flows.map((f) => {
      const s = f.steps[0];
      return [f.id, s ? `${s.label} — ${s.file}` : f.entryStableId] as const;
    }),
  );
  const idByEntry = new Map(compact.flows.map((f) => [f.entryStableId, f.id]));
  return {
    flows: compact.flows.map((f) => ({
      id: f.id,
      name: f.name,
      entry: entryOf.get(f.id) ?? f.entryStableId,
      changedCount: f.changedStableIds.length,
    })),
    mergeSuggestions: suggestMerges(compact.flows).map((s, i) => ({
      group: i,
      flowIds: s.entryStableIds.map((e) => idByEntry.get(e)!),
      names: s.names,
    })),
    orphanGroups: compact.orphanGroups.map((g) => ({ dir: g.dir, files: g.orphans.map((o) => o.file) })),
    changes: changes.map((c) => ({
      file: c.file,
      lines: `${c.startLine}-${c.endLine}`,
      label: c.label,
      kind: c.kind,
      status: c.status,
      added: c.added,
      removed: c.removed,
    })),
  };
}

export interface MergeSuggestion {
  /** Ready to paste as a unit's flowEntryStableIds. */
  entryStableIds: string[];
  names: string[];
  /** Evidence per qualifying pair, by flow name. */
  pairs: { a: string; b: string; shared: number; smaller: number }[];
}

/** Mechanical merge candidates per the skill guideline: two flows belong in one
 *  multi-entry unit when they share >= half of the smaller flow's changed set.
 *  Qualifying pairs union into components; the LLM keeps label/order judgment. */
export function suggestMerges(
  flows: { entryStableId: string; name: string; changedStableIds: string[] }[],
): MergeSuggestion[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  for (const f of flows) parent.set(f.entryStableId, f.entryStableId);

  const pairs: { aId: string; a: string; b: string; shared: number; smaller: number }[] = [];
  for (let i = 0; i < flows.length; i++) {
    for (let j = i + 1; j < flows.length; j++) {
      const A = flows[i];
      const B = flows[j];
      if (!A || !B) continue;
      const bSet = new Set(B.changedStableIds);
      const shared = A.changedStableIds.filter((id) => bSet.has(id)).length;
      const smaller = Math.min(A.changedStableIds.length, B.changedStableIds.length);
      if (shared > 0 && shared * 2 >= smaller) {
        pairs.push({ aId: A.entryStableId, a: A.name, b: B.name, shared, smaller });
        parent.set(find(A.entryStableId), find(B.entryStableId));
      }
    }
  }

  const groups = new Map<string, MergeSuggestion>();
  for (const f of flows) {
    const root = find(f.entryStableId);
    const g = groups.get(root) ?? { entryStableIds: [], names: [], pairs: [] };
    g.entryStableIds.push(f.entryStableId);
    g.names.push(f.name);
    groups.set(root, g);
  }
  for (const p of pairs) {
    groups.get(find(p.aId))!.pairs.push({ a: p.a, b: p.b, shared: p.shared, smaller: p.smaller });
  }
  return [...groups.values()].filter((g) => g.entryStableIds.length >= 2);
}

export interface SessionNode {
  id: string;
  stableId: string;
  label: string;
  file: string;
  startLine: number;
  endLine: number;
  changeStatus: string;
  reviewStatus: string;
  isTest: boolean;
}

/** Server-derived nesting (tests/DTOs/residuals under covered nodes).
 *  counted=false = cross-unit reference, render-only. */
export interface AttachedMember {
  stableId: string;
  parentStableId: string;
  reason: "tested-by" | "required-by" | "same-file";
  counted: boolean;
}
export interface Unit {
  id: string;
  label: string;
  kind: "flow" | "orphans";
  memberStableIds: string[];
  auto: boolean;
  attached: AttachedMember[];
}
export interface Coverage {
  changedTotal: number;
  covered: number;
  unassigned: number;
}
export interface SessionInfo {
  session: Session;
  units: Unit[];
  coverage: Coverage;
  stale?: boolean;
  staleReason?: "head-moved" | "working-tree-changed";
}

export type UnitInput =
  | {
      kind: "flow";
      flowEntryStableId?: string;
      flowEntryStableIds?: string[];
      /** Numeric flow ids as printed by `crw context` — resolved to entry
       *  stableIds CLI-side (resolvePlanRefs) before the plan is submitted. */
      flowIds?: number[];
      /** Index into `crw context`'s mergeSuggestions — expands to that
       *  group's entryStableIds. */
      mergeGroup?: number;
      label: string;
      rationale?: string;
    }
  | { kind: "orphans"; orphanStableIds?: string[]; orphanFiles?: string[]; label: string; rationale?: string };

/** Expand numeric plan refs (`flowIds`, `mergeGroup`) into
 *  `flowEntryStableIds`, so a plan can reference flows the way `crw context`
 *  names them instead of transcribing 100+-char SCIP stableIds. Resolution
 *  must run against the same compacted flows + suggestMerges output the
 *  context printed, so the numbering is guaranteed to line up. Unknown refs
 *  throw with the valid range — better a loud failure than a plan that
 *  silently reviews the wrong flow. */
export function resolvePlanRefs(
  units: UnitInput[],
  flows: { id: number; name: string; entryStableId: string }[],
  mergeSuggestions: MergeSuggestion[],
): UnitInput[] {
  const byId = new Map(flows.map((f) => [f.id, f.entryStableId]));
  return units.map((u) => {
    if (u.kind !== "flow" || (u.flowIds === undefined && u.mergeGroup === undefined)) return u;
    const entries = [...(u.flowEntryStableIds ?? []), ...(u.flowEntryStableId ? [u.flowEntryStableId] : [])];
    for (const id of u.flowIds ?? []) {
      const entry = byId.get(id);
      if (entry === undefined) {
        throw new Error(
          `unit '${u.label}': unknown flowId ${id} (affected flows: ${[...byId.keys()].join(", ") || "none"})`,
        );
      }
      entries.push(entry);
    }
    if (u.mergeGroup !== undefined) {
      const group = mergeSuggestions[u.mergeGroup];
      if (!group) {
        throw new Error(
          `unit '${u.label}': mergeGroup ${u.mergeGroup} out of range (${mergeSuggestions.length} suggestion(s), zero-indexed)`,
        );
      }
      entries.push(...group.entryStableIds);
    }
    const { flowIds: _ids, mergeGroup: _grp, flowEntryStableId: _single, ...rest } = u;
    return { ...rest, flowEntryStableIds: [...new Set(entries)] };
  });
}

/** Plan file for `crw plan --units`: either a bare UnitInput[] (legacy) or
 *  { overview?, units }. The overview travels with the plan so a replan
 *  always re-states (or clears) the narrative. */
export function parsePlanFile(text: string): { units: UnitInput[]; overview?: string } {
  const raw: unknown = JSON.parse(text);
  if (Array.isArray(raw)) return { units: raw as UnitInput[] };
  if (raw && typeof raw === "object" && Array.isArray((raw as { units?: unknown }).units)) {
    const overview = (raw as { overview?: unknown }).overview;
    return {
      units: (raw as { units: UnitInput[] }).units,
      ...(typeof overview === "string" && overview.trim() ? { overview } : {}),
    };
  }
  throw new Error("plan file must be a units array or { overview?, units }");
}

export interface CommentAnchor {
  startLine: number;
  startSide: "old" | "new";
  endLine: number;
  endSide: "old" | "new";
}
export interface ExportedNodeComment {
  scope: "node";
  id: string;
  nodeId: string;
  stableId: string;
  label: string;
  file: string;
  startLine: number;
  endLine: number;
  hunkSnippet: string;
  text: string;
  structuralContext: string;
  createdAt: number;
  anchor: CommentAnchor | null;
}
/** Session-wide remark; maps to a GitHub PR review body, not an inline comment. */
export interface ExportedSessionComment {
  scope: "session";
  id: string;
  text: string;
  createdAt: number;
}
export type ExportedComment = ExportedNodeComment | ExportedSessionComment;

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function createSession(
  base: string,
  branch: string,
  baseRef: string,
): Promise<{ session: Session; subgraph: ChangeSubgraph }> {
  return fetchJson(`${base}/api/sessions`, { method: "POST", body: JSON.stringify({ branch, baseRef }) });
}

export async function getSessionInfo(base: string, sessionId: string): Promise<SessionInfo> {
  return fetchJson(`${base}/api/sessions/${sessionId}`);
}

export async function listSessions(base: string): Promise<{ sessions: Session[] }> {
  return fetchJson(`${base}/api/sessions`);
}

export async function deleteSession(base: string, sessionId: string): Promise<{ deleted: string }> {
  return fetchJson(`${base}/api/sessions/${sessionId}`, { method: "DELETE" });
}

export async function shutdownHub(base: string): Promise<{ ok: boolean; pid?: number }> {
  return fetchJson(`${base}/api/shutdown`, { method: "POST" });
}

export async function getFlows(base: string, sessionId: string): Promise<{ flows: FlowDTO[]; orphans: OrphanDTO[] }> {
  return fetchJson(`${base}/api/sessions/${sessionId}/flows`);
}

export async function getChanges(
  base: string,
  sessionId: string,
): Promise<{ changes: ChangeSummary[]; commitSubjects?: string[] }> {
  return fetchJson(`${base}/api/sessions/${sessionId}/changes`);
}

export async function getNodes(base: string, sessionId: string): Promise<{ nodes: SessionNode[] }> {
  return fetchJson(`${base}/api/sessions/${sessionId}/nodes`);
}

export async function getNodeDiff(base: string, sessionId: string, nodeId: string): Promise<Record<string, unknown>> {
  return fetchJson(`${base}/api/sessions/${sessionId}/nodes/${nodeId}`);
}

export async function writePlan(
  base: string,
  sessionId: string,
  units: UnitInput[],
  overview?: string,
): Promise<{
  units: Unit[];
  coverage: Coverage;
  overview: string;
  unassigned: { stableId: string; label: string; file: string }[];
}> {
  return fetchJson(`${base}/api/sessions/${sessionId}/plan`, {
    method: "PUT",
    body: JSON.stringify(overview === undefined ? { units } : { units, overview }),
  });
}

export async function exportComments(
  base: string,
  sessionId: string,
): Promise<{ branch: string; baseRef: string; headSha: string; overview: string; comments: ExportedComment[] }> {
  return fetchJson(`${base}/api/sessions/${sessionId}/export`);
}

/** Deterministic plan: one flow-unit per affected flow. Orphans are left out
 *  on purpose — the server attaches tests/DTOs/residuals to the flow units at
 *  plan write (explicit membership would block that), and sweeps true
 *  leftovers into the auto "Unassigned changes" unit. */
export function defaultPartition(flows: FlowDTO[], _orphans: OrphanDTO[]): UnitInput[] {
  return flows
    .filter((f) => f.affected)
    .map((f) => ({ kind: "flow", flowEntryStableId: f.entryStableId, label: f.name }));
}

export function uiUrl(base: string, sessionId: string): string {
  return `${base}/?session=${sessionId}`;
}

export function launchUI(base: string, sessionId: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [uiUrl(base, sessionId)], { detached: true, stdio: "ignore" }).unref();
}
