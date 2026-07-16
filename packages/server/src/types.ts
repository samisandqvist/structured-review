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
  /** Per-language indexing degradation notices captured at session creation. */
  indexWarnings: string[];
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
  anchor: CommentAnchor | null;
}

export type AnchorSide = "old" | "new";
/** GitHub-shaped line anchor: endpoints are CHANGED diff lines; removed lines
 *  anchor by old-file line on side "old", added lines by new-file line on
 *  side "new". Range order is row position in the rendered node diff. */
export interface CommentAnchor {
  startLine: number;
  startSide: AnchorSide;
  endLine: number;
  endSide: AnchorSide;
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
  anchor: CommentAnchor | null;
}
