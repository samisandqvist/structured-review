export interface ReviewSession {
  id: string; branch: string; baseRef: string;
  status: "planning" | "walking" | "complete"; createdAt: number;
  indexWarnings?: string[];
  /** Plan-authored narrative ("the change does X, decomposed as…"); empty
   *  until a plan carrying one is submitted. */
  overview?: string;
}
/** A changed node the server nested under a covered node at plan-write time.
 *  counted=false = cross-unit reference: render-only, not in walk/coverage. */
export interface AttachedMember {
  stableId: string;
  parentStableId: string;
  reason: "tested-by" | "required-by" | "same-file";
  counted: boolean;
}
export interface Unit {
  id: string; sessionId: string; position: number; label: string;
  rationale: string;
  kind: "flow" | "orphans";
  memberStableIds: string[];
  auto: boolean;
  attached: AttachedMember[];
}
export interface LineRange { start: number; end: number; }
/** Why a residual pseudo-node sits outside the call graph. */
export type ResidualKind = "module-scope" | "whole-file" | "deleted";
export interface Node {
  id: string; sessionId: string; stableId: string;
  label: string; file: string; startLine: number; endLine: number;
  changeStatus: "changed" | "unchanged";
  reviewStatus: "unreviewed" | "reviewed-clean" | "reviewed-commented" | "reviewed-elsewhere";
  reviewedInUnit: number | null;
  isTest: boolean;
  residualRanges?: LineRange[] | null;
  residualKind?: ResidualKind | null;
}
export type AnchorSide = "old" | "new";
export interface CommentAnchor {
  startLine: number;
  startSide: AnchorSide;
  endLine: number;
  endSide: AnchorSide;
}
export interface Comment {
  id: string; sessionId: string;
  /** null = session-wide comment (no node, no anchor). */
  nodeId: string | null;
  hunkSnippet: string;
  text: string; structuralContext: string; createdAt: number;
  anchor: CommentAnchor | null;
}
export interface DiffLine {
  type: "context" | "added" | "removed";
  oldLine: number | null;
  newLine: number | null;
  text: string;
  /** Client-side: revealed via context expansion — outside the node's own
   *  diff, so never selectable as a comment anchor. */
  expanded?: boolean;
}
export interface NodeDiff {
  oldText: string;
  newText: string;
  lines: DiffLine[];
  /** Working-tree line count of the node's file (0 when unreadable). */
  totalLines: number;
}
export interface FlowStep {
  stableId: string;
  label: string;
  file: string;
  startLine: number;
  endLine: number;
  isTest: boolean;
  depth: number;
  /** One-hop context on a pruned tree, not on a path to a change. */
  offPath?: boolean;
  /** Set when the step is a residual pseudo-node (orphan-unit members only). */
  residualKind?: ResidualKind | null;
  nodeId: string | null;
  changeStatus: "changed" | "unchanged" | null;
  reviewStatus: Node["reviewStatus"] | null;
}
export interface Flow {
  id: number;
  name: string;
  criticality: number;
  depth: number;
  affected: boolean;
  changedStableIds: string[];
  steps: FlowStep[];
  entryStableId: string;
  entryReasons: string[];
  entryConfidence: number;
}
export interface GraphEdgeDTO {
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: "call" | "test";
}
export interface GraphNode {
  stableId: string; label: string; file: string; startLine: number; endLine: number;
  isEntryPoint: boolean; changeStatus: "changed" | "unchanged";
}
export interface GraphEdge { sourceStableId: string; targetStableId: string; edgeType: "call"; }
export interface ChangeSubgraph { nodes: GraphNode[]; edges: GraphEdge[]; }

export interface Coverage { changedTotal: number; covered: number; unassigned: number; }
export type UnitInput =
  | { kind: "flow"; flowEntryStableId?: string; flowEntryStableIds?: string[]; label: string; rationale?: string }
  | { kind: "orphans"; orphanStableIds: string[]; label: string; rationale?: string };

const API_BASE = "/api";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init, headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  listSessions: () => fetchJson<{ sessions: ReviewSession[] }>("/sessions"),
  createSession: (branch: string, baseRef: string) =>
    fetchJson<{ session: ReviewSession; subgraph: ChangeSubgraph }>("/sessions", {
      method: "POST", body: JSON.stringify({ branch, baseRef }),
    }),
  getSession: (id: string) =>
    fetchJson<{ session: ReviewSession; units: Unit[]; coverage: Coverage; stale?: boolean }>(`/sessions/${id}`),
  updatePlan: (id: string, units: UnitInput[]) =>
    fetchJson<{ units: Unit[]; coverage: Coverage }>(`/sessions/${id}/plan`, {
      method: "PUT", body: JSON.stringify({ units }),
    }),
  getNodes: (id: string) =>
    fetchJson<{ nodes: Node[]; edges: GraphEdgeDTO[] }>(`/sessions/${id}/nodes`),
  getNode: (sessionId: string, nodeId: string) =>
    fetchJson<{ node: Node; callers: Node[]; callees: Node[]; diff: NodeDiff }>(
      `/sessions/${sessionId}/nodes/${nodeId}`
    ),
  getNodeContext: (sessionId: string, nodeId: string, start: number, end: number) =>
    fetchJson<{ lines: DiffLine[] }>(
      `/sessions/${sessionId}/nodes/${nodeId}/context?start=${start}&end=${end}`
    ),
  updateNodeStatus: (sessionId: string, nodeId: string, reviewStatus: Node["reviewStatus"], reviewedInUnit?: number) =>
    fetchJson<{ node: Node }>(`/sessions/${sessionId}/nodes/${nodeId}`, {
      method: "PATCH", body: JSON.stringify({ reviewStatus, reviewedInUnit }),
    }),
  bulkUpdateNodeStatus: (sessionId: string, nodeIds: string[], reviewStatus: Node["reviewStatus"]) =>
    fetchJson<{ nodes: Node[] }>(`/sessions/${sessionId}/nodes`, {
      method: "PATCH", body: JSON.stringify({ nodeIds, reviewStatus }),
    }),
  getComments: (id: string) =>
    fetchJson<{ comments: Comment[] }>(`/sessions/${id}/comments`),
  createComment: (id: string, nodeId: string | null, text: string, anchor?: CommentAnchor) =>
    fetchJson<{ comment: Comment }>(`/sessions/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({ ...(nodeId ? { nodeId } : {}), text, ...(anchor ? { anchor } : {}) }),
    }),
  updateUnit: (sessionId: string, unitId: string, patch: { label?: string; position?: number }) =>
    fetchJson<{ units: Unit[] }>(`/sessions/${sessionId}/units/${unitId}`, {
      method: "PATCH", body: JSON.stringify(patch),
    }),
  getFlows: (id: string) => fetchJson<{ flows: Flow[]; orphans: Node[] }>(`/sessions/${id}/flows`),
  exportComments: (id: string) =>
    fetchJson<{ branch: string; baseRef: string; headSha: string; comments: Record<string, unknown>[] }>(
      `/sessions/${id}/export`
    ),
};
