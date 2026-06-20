import type { DB } from "../db/connection.js";
import type { Node, ReviewStatus, ChangeStatus } from "../types.js";
import { randomId } from "../util.js";

interface NodeRow {
  id: string; session_id: string; stable_id: string; unit_id: string | null;
  label: string; file: string; start_line: number; end_line: number;
  change_status: ChangeStatus; review_status: ReviewStatus; reviewed_in_unit: number | null;
}

function rowToNode(row: NodeRow): Node {
  return {
    id: row.id, sessionId: row.session_id, stableId: row.stable_id, unitId: row.unit_id,
    label: row.label, file: row.file, startLine: row.start_line, endLine: row.end_line,
    changeStatus: row.change_status, reviewStatus: row.review_status, reviewedInUnit: row.reviewed_in_unit,
  };
}

export function createNode(db: DB, node: Omit<Node, "id">): Node {
  const id = randomId("node");
  db.prepare(
    `INSERT INTO nodes (id, session_id, stable_id, unit_id, label, file, start_line, end_line, change_status, review_status, reviewed_in_unit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, node.sessionId, node.stableId, node.unitId, node.label, node.file,
    node.startLine, node.endLine, node.changeStatus, node.reviewStatus, node.reviewedInUnit);
  return { ...node, id };
}

export function getNodesBySession(db: DB, sessionId: string): Node[] {
  return (db.prepare("SELECT * FROM nodes WHERE session_id = ?").all(sessionId) as NodeRow[]).map(rowToNode);
}

export function getNodesByUnit(db: DB, unitId: string): Node[] {
  return (db.prepare("SELECT * FROM nodes WHERE unit_id = ?").all(unitId) as NodeRow[]).map(rowToNode);
}

export function getNode(db: DB, id: string): Node | undefined {
  const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
  return row ? rowToNode(row) : undefined;
}

export function getNodeNeighbors(db: DB, nodeId: string): { callers: Node[]; callees: Node[] } {
  const callers = (db.prepare(
    `SELECT n.* FROM nodes n JOIN edges e ON e.source_node_id = n.id WHERE e.target_node_id = ?`
  ).all(nodeId) as NodeRow[]).map(rowToNode);
  const callees = (db.prepare(
    `SELECT n.* FROM nodes n JOIN edges e ON e.target_node_id = n.id WHERE e.source_node_id = ?`
  ).all(nodeId) as NodeRow[]).map(rowToNode);
  return { callers, callees };
}

export function updateNodeReviewStatus(db: DB, id: string, status: ReviewStatus, reviewedInUnit?: number): void {
  db.prepare("UPDATE nodes SET review_status = ?, reviewed_in_unit = ? WHERE id = ?")
    .run(status, reviewedInUnit ?? null, id);
}
