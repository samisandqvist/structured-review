import Database from "better-sqlite3";
import { join } from "node:path";
import { repoRoot } from "./diff.js";

/**
 * EXPERIMENT: read execution flows from CRG's graph store.
 *
 * CRG traces "flows" — ordered call paths from an entry point to a leaf — and
 * stores them in its own SQLite graph (.code-review-graph/graph.db). The flow
 * path is a list of CRG node ids; we resolve each to the node's qualified name
 * (which is our stableId), so the review server can line flows up against a
 * session's changed nodes. Reading CRG's DB directly is a deliberate shortcut
 * for the experiment — the MCP API exposes flows but not id→node resolution.
 */
export interface FlowStep {
  stableId: string;
  label: string;
  file: string;
  startLine: number;
  endLine: number;
  isTest: boolean;
  depth: number;
}
export interface Flow {
  id: number;
  name: string;
  criticality: number;
  depth: number;
  steps: FlowStep[];
}

interface FlowRow {
  id: number;
  name: string;
  criticality: number;
  depth: number;
  path_json: string;
}
interface NodeRow {
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
    const flows = db
      .prepare("SELECT id, name, criticality, depth, path_json FROM flows ORDER BY criticality DESC")
      .all() as FlowRow[];
    const nodeStmt = db.prepare(
      "SELECT name, qualified_name, file_path, line_start, line_end, is_test FROM nodes WHERE id = ?"
    );
    // Call adjacency by qualified name, to recover each step's depth in the tree.
    const callAdj = new Map<string, string[]>();
    for (const e of db
      .prepare("SELECT source_qualified, target_qualified FROM edges WHERE kind = 'CALLS'")
      .all() as { source_qualified: string; target_qualified: string }[]) {
      (callAdj.get(e.source_qualified) ?? callAdj.set(e.source_qualified, []).get(e.source_qualified)!).push(
        e.target_qualified
      );
    }
    const rootSlash = root.endsWith("/") ? root : `${root}/`;

    return flows.map((f) => {
      const path = safeParsePath(f.path_json);
      const steps: FlowStep[] = [];
      for (const nid of path) {
        const n = nodeStmt.get(nid) as NodeRow | undefined;
        if (!n) continue;
        steps.push({
          stableId: n.qualified_name,
          label: n.name,
          file: n.file_path.startsWith(rootSlash) ? n.file_path.slice(rootSlash.length) : n.file_path,
          startLine: n.line_start,
          endLine: n.line_end,
          isTest: n.is_test === 1,
          depth: 0,
        });
      }
      assignDepths(steps, callAdj);
      return { id: f.id, name: f.name, criticality: f.criticality, depth: f.depth, steps };
    });
  } finally {
    db.close();
  }
}

/**
 * Recover each step's tree depth by BFS from the flow's entry (steps[0]) over
 * call edges restricted to the flow's nodes — mirroring how CRG traced it.
 * CRG stores only the flattened BFS path, so siblings (a caller's several
 * callees) sit at the same depth; this is what lets the UI render the tree.
 */
function assignDepths(steps: FlowStep[], callAdj: Map<string, string[]>): void {
  if (steps.length === 0) return;
  const inFlow = new Set(steps.map((s) => s.stableId));
  const depthByQn = new Map<string, number>([[steps[0].stableId, 0]]);
  const queue = [steps[0].stableId];
  while (queue.length) {
    const cur = queue.shift()!;
    const d = depthByQn.get(cur)!;
    for (const next of callAdj.get(cur) ?? []) {
      if (inFlow.has(next) && !depthByQn.has(next)) {
        depthByQn.set(next, d + 1);
        queue.push(next);
      }
    }
  }
  for (const s of steps) s.depth = depthByQn.get(s.stableId) ?? 0;
}

function safeParsePath(json: string): number[] {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
