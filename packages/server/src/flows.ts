import Database from "better-sqlite3";
import { join } from "node:path";
import { repoRoot } from "./diff.js";
import type { Flow } from "./graph/provider.js";
import { buildFlowTree, type FlowNodeInfo } from "./graph/flow-tree.js";

/**
 * Read execution flows from CRG's graph store (used by CrgGraphProvider.getFlows).
 *
 * CRG traces flows and stores them in its own SQLite graph
 * (.code-review-graph/graph.db). We take only CRG's entry points + criticality,
 * then rebuild the real call tree from the edges via the shared DFS builder, so
 * shared nodes show at each call site. Reading CRG's DB directly is a shortcut —
 * the MCP API exposes flows but not id→node resolution.
 */
interface FlowRow {
  id: number;
  name: string;
  criticality: number;
  entry_point_id: number;
}
interface NodeRow {
  id: number;
  name: string;
  qualified_name: string;
  file_path: string;
  line_start: number;
  line_end: number;
  is_test: number;
}

export function readFlows(root: string = repoRoot()): Flow[] {
  const dbPath = process.env.CRG_GRAPH_DB || join(root, ".code-review-graph", "graph.db");
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return []; // no CRG graph built — flows unavailable
  }
  try {
    // CRG tells us the entry points worth tracing (+ its criticality ranking);
    // we ignore its flattened/deduped stored path and rebuild the real call tree
    // ourselves from the edges, so shared nodes show at each call site.
    const flows = db
      .prepare("SELECT id, name, criticality, entry_point_id FROM flows ORDER BY criticality DESC")
      .all() as FlowRow[];

    const nodeById = new Map<number, NodeRow>();
    const nodeByQn = new Map<string, NodeRow>();
    for (const n of db
      .prepare("SELECT id, name, qualified_name, file_path, line_start, line_end, is_test FROM nodes")
      .all() as NodeRow[]) {
      nodeById.set(n.id, n);
      nodeByQn.set(n.qualified_name, n);
    }

    // Dedupe per (caller, callee): CRG records an edge per call site, but a
    // function called 3× shouldn't appear as 3 identical subtrees. A callee can
    // still appear under several *different* callers.
    const callSets = new Map<string, Set<string>>();
    for (const e of db
      .prepare("SELECT source_qualified, target_qualified FROM edges WHERE kind = 'CALLS'")
      .all() as { source_qualified: string; target_qualified: string }[]) {
      (callSets.get(e.source_qualified) ?? callSets.set(e.source_qualified, new Set()).get(e.source_qualified)!).add(
        e.target_qualified
      );
    }
    const callAdj = new Map<string, string[]>();
    for (const [src, tgts] of callSets) callAdj.set(src, [...tgts]);

    const rootSlash = root.endsWith("/") ? root : `${root}/`;
    const rel = (p: string) => (p.startsWith(rootSlash) ? p.slice(rootSlash.length) : p);
    const resolve = (qn: string): FlowNodeInfo | undefined => {
      const n = nodeByQn.get(qn);
      return n
        ? { label: n.name, file: rel(n.file_path), startLine: n.line_start, endLine: n.line_end, isTest: n.is_test === 1 }
        : undefined;
    };

    return flows
      .map((f) => {
        const entry = nodeById.get(f.entry_point_id);
        if (!entry) return null;
        const steps = buildFlowTree(entry.qualified_name, callAdj, resolve);
        const depth = steps.reduce((m, s) => Math.max(m, s.depth), 0);
        return { id: f.id, name: f.name, criticality: f.criticality, depth, steps };
      })
      .filter((f): f is Flow => f !== null && f.steps.length > 1);
  } finally {
    db.close();
  }
}
