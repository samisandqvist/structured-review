import type { Flow, FlowStep } from "./provider.js";

export interface FlowNodeInfo {
  label: string;
  file: string;
  startLine: number;
  endLine: number;
  isTest: boolean;
}

const MAX_TREE_DEPTH = 10;
const MAX_TREE_STEPS = 120;

/**
 * Depth-first call tree from an entry, preorder so each node is immediately
 * followed by its children (indent = real nesting). No global dedup — a shared
 * callee shows under each caller — but an ancestor set guards cycles and
 * depth/step caps bound fan-out. Shared between graph providers.
 */
export function buildFlowTree(
  entry: string,
  callAdj: Map<string, string[]>,
  resolve: (sym: string) => FlowNodeInfo | undefined
): FlowStep[] {
  const steps: FlowStep[] = [];
  const ancestors = new Set<string>();
  const walk = (sym: string, depth: number) => {
    if (steps.length >= MAX_TREE_STEPS) return;
    const info = resolve(sym);
    if (!info) return;
    steps.push({ stableId: sym, ...info, depth });
    if (depth >= MAX_TREE_DEPTH) return;
    ancestors.add(sym);
    for (const callee of callAdj.get(sym) ?? []) {
      if (!ancestors.has(callee)) walk(callee, depth + 1);
    }
    ancestors.delete(sym);
  };
  walk(entry, 0);
  return steps;
}

/** Rough 0–1 score so flows can be ranked when the indexer gives none. */
export function flowCriticality(steps: FlowStep[]): number {
  const distinct = new Set(steps.map((s) => s.stableId)).size;
  const maxDepth = steps.reduce((m, s) => Math.max(m, s.depth), 0);
  return Math.min(1, (distinct * 0.6 + maxDepth * 0.4) / 12);
}

export function makeFlow(id: number, name: string, steps: FlowStep[]): Flow {
  return { id, name, criticality: flowCriticality(steps), depth: steps.reduce((m, s) => Math.max(m, s.depth), 0), steps };
}
