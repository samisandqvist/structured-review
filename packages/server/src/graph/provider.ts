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
}
