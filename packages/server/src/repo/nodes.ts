import type { DB } from "../db/connection.js";
import type { Node, ReviewStatus, ChangeStatus, LineRange } from "../types.js";
import { randomId } from "../util.js";

interface NodeRow {
  id: string; session_id: string; stable_id: string;
  label: string; file: string; start_line: number; end_line: number;
  change_status: ChangeStatus; review_status: ReviewStatus; reviewed_in_unit: number | null;
  is_test: number;
  residual_ranges: string | null;
}

function rowToNode(row: NodeRow): Node {
  return {
    id: row.id, sessionId: row.session_id, stableId: row.stable_id,
    label: row.label, file: row.file, startLine: row.start_line, endLine: row.end_line,
    changeStatus: row.change_status, reviewStatus: row.review_status, reviewedInUnit: row.reviewed_in_unit,
    isTest: row.is_test === 1,
    residualRanges: row.residual_ranges ? (JSON.parse(row.residual_ranges) as LineRange[]) : null,
  };
}

export function createNode(
  db: DB,
  node: Omit<Node, "id" | "residualRanges"> & { residualRanges?: LineRange[] | null }
): Node {
  const id = randomId("node");
  const residualRanges = node.residualRanges ?? null;
  db.prepare(
    `INSERT INTO nodes (id, session_id, stable_id, label, file, start_line, end_line, change_status, review_status, reviewed_in_unit, is_test, residual_ranges)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, node.sessionId, node.stableId, node.label, node.file,
    node.startLine, node.endLine, node.changeStatus, node.reviewStatus, node.reviewedInUnit, node.isTest ? 1 : 0,
    residualRanges ? JSON.stringify(residualRanges) : null);
  return { ...node, id, residualRanges };
}

export function getNodesBySession(db: DB, sessionId: string): Node[] {
  return (db.prepare("SELECT * FROM nodes WHERE session_id = ?").all(sessionId) as NodeRow[]).map(rowToNode);
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
