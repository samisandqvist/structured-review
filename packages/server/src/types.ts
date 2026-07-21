export type SessionStatus = "planning" | "walking" | "complete";
export type UnitKind = "flow" | "orphans";
export type ChangeStatus = "changed" | "unchanged";
export type ReviewStatus =
  | "unreviewed"
  | "reviewed-clean"
  | "reviewed-commented"
  | "reviewed-elsewhere";
export type EdgeType = "call" | "test";
/** Why a residual pseudo-node exists outside the call graph:
 *  module-scope = top-of-module changes (imports/types/constants) in a file
 *  that also has indexed nodes; whole-file = no indexed nodes in the file at
 *  all; deleted = the file only lost lines. */
export type ResidualKind = "module-scope" | "whole-file" | "deleted";

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

export type AttachReason = "tested-by" | "required-by" | "same-file";

/** A changed node the server nested under a covered node at plan-write time.
 *  counted=false is a cross-unit reference entry: render-only, never in walk
 *  order or coverage. */
export interface AttachedMember {
  stableId: string;
  parentStableId: string;
  reason: AttachReason;
  counted: boolean;
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
  attached: AttachedMember[];
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
  residualKind: ResidualKind | null;
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
  /** null = session-wide comment: no node, no anchor, no snippet. */
  nodeId: string | null;
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
