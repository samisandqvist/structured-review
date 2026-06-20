export type SessionStatus = "planning" | "walking" | "complete";
export type ChangeStatus = "changed" | "unchanged";
export type ReviewStatus =
  | "unreviewed"
  | "reviewed-clean"
  | "reviewed-commented"
  | "reviewed-elsewhere";
export type EdgeType = "call";

export interface ReviewSession {
  id: string;
  branch: string;
  baseRef: string;
  status: SessionStatus;
  createdAt: number;
}

export interface Unit {
  id: string;
  sessionId: string;
  position: number;
  label: string;
  rationale: string;
  entryPointNodeIds: string[];
}

export interface Node {
  id: string;
  sessionId: string;
  stableId: string;
  unitId: string | null;
  label: string;
  file: string;
  startLine: number;
  endLine: number;
  changeStatus: ChangeStatus;
  reviewStatus: ReviewStatus;
  reviewedInUnit: number | null;
}

export interface Edge {
  id: string;
  sessionId: string;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: EdgeType;
}

export interface Comment {
  id: string;
  sessionId: string;
  nodeId: string;
  hunkSnippet: string;
  text: string;
  structuralContext: string;
  createdAt: number;
}

export interface ExportedComment {
  nodeId: string;
  stableId: string;
  label: string;
  file: string;
  hunkSnippet: string;
  text: string;
  structuralContext: string;
  createdAt: number;
}
