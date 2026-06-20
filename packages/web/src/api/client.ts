export interface ReviewSession {
  id: string; branch: string; baseRef: string;
  status: "planning" | "walking" | "complete"; createdAt: number;
}
export interface Unit {
  id: string; sessionId: string; position: number; label: string;
  rationale: string; entryPointNodeIds: string[];
}
export interface Node {
  id: string; sessionId: string; stableId: string; unitId: string | null;
  label: string; file: string; startLine: number; endLine: number;
  changeStatus: "changed" | "unchanged";
  reviewStatus: "unreviewed" | "reviewed-clean" | "reviewed-commented" | "reviewed-elsewhere";
  reviewedInUnit: number | null;
}
export interface Comment {
  id: string; sessionId: string; nodeId: string; hunkSnippet: string;
  text: string; structuralContext: string; createdAt: number;
}
export interface GraphNode {
  stableId: string; label: string; file: string; startLine: number; endLine: number;
  isEntryPoint: boolean; changeStatus: "changed" | "unchanged";
}
export interface GraphEdge { sourceStableId: string; targetStableId: string; edgeType: "call"; }
export interface ChangeSubgraph { nodes: GraphNode[]; edges: GraphEdge[]; }

const API_BASE = "/api";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init, headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  createSession: (branch: string, baseRef: string) =>
    fetchJson<{ session: ReviewSession; subgraph: ChangeSubgraph }>("/sessions", {
      method: "POST", body: JSON.stringify({ branch, baseRef }),
    }),
  getSession: (id: string) =>
    fetchJson<{ session: ReviewSession; units: Unit[] }>(`/sessions/${id}`),
  updatePlan: (id: string, units: { label: string; rationale: string; entryPointNodeIds: string[] }[]) =>
    fetchJson<{ units: Unit[] }>(`/sessions/${id}/plan`, {
      method: "PUT", body: JSON.stringify({ units }),
    }),
  getNodes: (id: string, unitId?: string) =>
    fetchJson<{ nodes: Node[]; edges: { sourceNodeId: string; targetNodeId: string }[] }>(
      `/sessions/${id}/nodes${unitId ? `?unitId=${unitId}` : ""}`
    ),
  getNode: (sessionId: string, nodeId: string) =>
    fetchJson<{ node: Node; callers: Node[]; callees: Node[] }>(`/sessions/${sessionId}/nodes/${nodeId}`),
  updateNodeStatus: (sessionId: string, nodeId: string, reviewStatus: Node["reviewStatus"], reviewedInUnit?: number) =>
    fetchJson<{ node: Node }>(`/sessions/${sessionId}/nodes/${nodeId}`, {
      method: "PATCH", body: JSON.stringify({ reviewStatus, reviewedInUnit }),
    }),
  getComments: (id: string) =>
    fetchJson<{ comments: Comment[] }>(`/sessions/${id}/comments`),
  createComment: (id: string, nodeId: string, hunkSnippet: string, text: string, structuralContext: string) =>
    fetchJson<{ comment: Comment }>(`/sessions/${id}/comments`, {
      method: "POST", body: JSON.stringify({ nodeId, hunkSnippet, text, structuralContext }),
    }),
  exportComments: (id: string) =>
    fetchJson<Record<string, unknown>>(`/sessions/${id}/export`),
};
