import type { DB } from "../db/connection.js";
import type { GraphEdge } from "../graph/provider.js";
import type { TestEdge } from "../attach.js";
import { randomId } from "../util.js";

/** Persist a change subgraph's edges for a session. Edges whose endpoints are
 *  not session nodes are dropped; a missing weight is one reference. */
export function insertEdges(db: DB, sessionId: string, edges: GraphEdge[], idByStable: Map<string, string>): void {
  const insert = db.prepare(
    "INSERT INTO edges (id, session_id, source_node_id, target_node_id, edge_type, weight) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const edge of edges) {
    const source = idByStable.get(edge.sourceStableId);
    const target = idByStable.get(edge.targetStableId);
    if (source && target) insert.run(randomId("edge"), sessionId, source, target, edge.edgeType, edge.weight ?? 1);
  }
}

/** A session's TESTED_BY edges by stableId, for attachment derivation. */
export function getTestEdges(db: DB, sessionId: string): TestEdge[] {
  const rows = db
    .prepare(
      `SELECT sn.stable_id AS prod, tn.stable_id AS test, e.weight AS weight
       FROM edges e JOIN nodes sn ON e.source_node_id = sn.id JOIN nodes tn ON e.target_node_id = tn.id
       WHERE e.session_id = ? AND e.edge_type = 'test'`,
    )
    .all(sessionId) as { prod: string; test: string; weight: number }[];
  return rows.map((r) => ({ productionStableId: r.prod, testStableId: r.test, weight: r.weight }));
}
