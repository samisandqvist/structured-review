export type SessionStatus = "planning" | "walking" | "complete";
export type UnitKind = "flow" | "orphans";
export type ChangeStatus = "changed" | "unchanged";
export type ReviewStatus =
  | "unreviewed"
  | "reviewed-clean"
  | "reviewed-commented"
  | "reviewed-elsewhere";
export type EdgeType = "call" | "test";

export interface LineRange {
  start: number;
  end: number;
}

export interface ReviewSession {
  id: string;
  branch: string;
  baseRef: string;
  status: SessionStatus;
  createdAt: number;
  headSha: string;
  repoFingerprint: string;
}

export interface Unit {
  id: string;
  sessionId: string;
  position: number;
  label: string;
  rationale: string;
  kind: UnitKind;
  memberStableIds: string[];
  auto: boolean;
}

export interface Node {
  id: string;
  sessionId: string;
  stableId: string;
  label: string;
  file: string;
  startLine: number;
  endLine: number;
  changeStatus: ChangeStatus;
  reviewStatus: ReviewStatus;
  reviewedInUnit: number | null;
  isTest: boolean;
  residualRanges: LineRange[] | null;
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
}
