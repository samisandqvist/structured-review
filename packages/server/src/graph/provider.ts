import type { ChangeStatus, EdgeType } from "../types.js";

export interface GraphNode {
  stableId: string;
  label: string;
  file: string;
  startLine: number;
  endLine: number;
  isEntryPoint: boolean;
  changeStatus: ChangeStatus;
  isTest: boolean;
}

export interface GraphEdge {
  sourceStableId: string;
  targetStableId: string;
  edgeType: EdgeType;
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
  /** With relevance pruning: this step is one-hop context, not on a path to a change. */
  offPath?: boolean;
}
export interface Flow {
  id: number;
  name: string;
  criticality: number;
  depth: number;
  steps: FlowStep[];
  /** Why the entry heads this flow (graph-root / exported / configured). */
  entryReasons?: string[];
  /** 0–1; 1.0 = explicitly configured, 0.4 = bare graph root. */
  entryConfidence?: number;
}

export interface GraphProvider {
  getChangeSubgraph(branch: string, baseRef: string): Promise<ChangeSubgraph>;
  getNeighbors(stableId: string): Promise<{ callers: GraphNode[]; callees: GraphNode[] }>;
  /** Execution flows (call trees from entry points). [] if unsupported.
   *  With changedStableIds, trees are pruned to change-relevant paths + one-hop context. */
  getFlows(changedStableIds?: Set<string>): Promise<Flow[]>;
  /** Optional: per-language indexing degradation notices for the current build
   *  (e.g. "Java indexing skipped: toolchain missing"). Absent/[] = none. */
  getIndexWarnings?(): Promise<string[]>;
  /** Optional: file-level requires relation — consumer file -> files defining
   *  the symbols it references/imports, with per-edge evidence strength:
   *  hasValueRef is true when at least one referenced symbol is a value
   *  (function, method, term — not a bare SCIP `#` type). Used to attach
   *  changed DTOs to their consumers at plan time (type edges included) and
   *  to filter test-import candidates (type-only edges are weak evidence,
   *  #12). Absent/empty = required-by pass finds nothing. */
  getFileRequires?(): Promise<FileRequires>;
}

/** consumer file -> defining file -> evidence strength of the edge. */
export type FileRequires = Map<string, Map<string, { hasValueRef: boolean }>>;
