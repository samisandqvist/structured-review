// packages/skill/src/api.ts — typed client for the review hub HTTP API.
// Every function takes the hub base URL explicitly; no SQLite access anywhere,
// so the CLI stays correct across schema migrations.
import { spawn } from "node:child_process";

export const DEFAULT_BASE_URL = process.env.CRW_SERVER_URL || "http://localhost:3456";

export interface Session {
  id: string; branch: string; baseRef: string; status: string; createdAt: number;
  headSha?: string; indexWarnings?: string[];
}
export interface GraphNode { stableId: string; label: string; file: string; startLine: number; endLine: number; isEntryPoint: boolean; changeStatus: string; }
export interface GraphEdge { sourceStableId: string; targetStableId: string; edgeType: string; }
export interface ChangeSubgraph { nodes: GraphNode[]; edges: GraphEdge[]; }

export interface FlowStep {
  stableId: string; label: string; file: string; startLine: number; endLine: number;
  isTest: boolean; depth: number;
  nodeId: string | null; changeStatus: string | null; reviewStatus: string | null;
}
export interface FlowDTO { id: number; name: string; affected: boolean; entryStableId: string; changedStableIds: string[]; steps: FlowStep[]; }
export interface OrphanDTO { stableId: string; label: string; file: string; }

export interface SessionNode {
  id: string; stableId: string; label: string; file: string;
  startLine: number; endLine: number;
  changeStatus: string; reviewStatus: string; isTest: boolean;
}

/** Server-derived nesting (tests/DTOs/residuals under covered nodes).
 *  counted=false = cross-unit reference, render-only. */
export interface AttachedMember {
  stableId: string;
  parentStableId: string;
  reason: "tested-by" | "required-by" | "same-file";
  counted: boolean;
}
export interface Unit { id: string; label: string; kind: "flow" | "orphans"; memberStableIds: string[]; auto: boolean; attached: AttachedMember[]; }
export interface Coverage { changedTotal: number; covered: number; unassigned: number; }
export interface SessionInfo {
  session: Session; units: Unit[]; coverage: Coverage;
  stale?: boolean; staleReason?: "head-moved" | "working-tree-changed";
}

export type UnitInput =
  | { kind: "flow"; flowEntryStableId?: string; flowEntryStableIds?: string[]; label: string; rationale?: string }
  | { kind: "orphans"; orphanStableIds: string[]; label: string; rationale?: string };

export interface ExportedComment {
  id: string; nodeId: string; stableId: string; label: string; file: string;
  startLine: number; endLine: number;
  hunkSnippet: string; text: string; structuralContext: string; createdAt: number;
  anchor: { startLine: number; endLine: number; side: string } | null;
}

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init, headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function createSession(base: string, branch: string, baseRef: string): Promise<{ session: Session; subgraph: ChangeSubgraph }> {
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

export async function getChanges(base: string, sessionId: string): Promise<{ changes: unknown[] }> {
  return fetchJson(`${base}/api/sessions/${sessionId}/changes`);
}

export async function getNodes(base: string, sessionId: string): Promise<{ nodes: SessionNode[] }> {
  return fetchJson(`${base}/api/sessions/${sessionId}/nodes`);
}

export async function getNodeDiff(base: string, sessionId: string, nodeId: string): Promise<Record<string, unknown>> {
  return fetchJson(`${base}/api/sessions/${sessionId}/nodes/${nodeId}`);
}

export async function writePlan(
  base: string, sessionId: string, units: UnitInput[]
): Promise<{ units: Unit[]; coverage: Coverage }> {
  return fetchJson(`${base}/api/sessions/${sessionId}/plan`, { method: "PUT", body: JSON.stringify({ units }) });
}

export async function exportComments(
  base: string, sessionId: string
): Promise<{ branch: string; baseRef: string; headSha: string; comments: ExportedComment[] }> {
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
