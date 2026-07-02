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

/** Symbols from which some changed symbol is reachable via calls (incl. the changed set). */
export function reachesChanged(changed: Set<string>, callAdj: Map<string, string[]>): Set<string> {
  const rev = new Map<string, string[]>();
  for (const [src, tgts] of callAdj) {
    for (const t of tgts) {
      const callers = rev.get(t) ?? [];
      callers.push(src);
      rev.set(t, callers);
    }
  }
  const relevant = new Set(changed);
  const queue = [...changed];
  while (queue.length) {
    const sym = queue.pop()!;
    for (const caller of rev.get(sym) ?? []) {
      if (!relevant.has(caller)) {
        relevant.add(caller);
        queue.push(caller);
      }
    }
  }
  return relevant;
}

/**
 * Depth-first call tree from an entry, preorder so each node is immediately
 * followed by its children (indent = real nesting). No global dedup — a shared
 * callee shows under each caller — but an ancestor set guards cycles. Without
 * `relevant`, depth/step caps bound fan-out as before. With `relevant` (symbols
 * that reach a change), the walk descends only along change-relevant paths;
 * off-path callees are emitted once as `offPath` context leaves, the step cap
 * applies to those leaves only, and an on-path step is never dropped by a cap.
 * Shared between graph providers.
 */
export function buildFlowTree(
  entry: string,
  callAdj: Map<string, string[]>,
  resolve: (sym: string) => FlowNodeInfo | undefined,
  relevant?: Set<string>
): FlowStep[] {
  const steps: FlowStep[] = [];
  let offPathCount = 0;
  const ancestors = new Set<string>();
  const walk = (sym: string, depth: number) => {
    const info = resolve(sym);
    if (!info) return;
    const onPath = !relevant || relevant.has(sym) || depth === 0;
    if (relevant && !onPath && offPathCount >= MAX_TREE_STEPS) return;
    if (!relevant && steps.length >= MAX_TREE_STEPS) return;
    steps.push({ stableId: sym, ...info, depth, offPath: relevant ? !onPath && depth > 0 : false });
    if (relevant && !onPath) {
      offPathCount++;
      return; // context leaf: don't descend
    }
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
