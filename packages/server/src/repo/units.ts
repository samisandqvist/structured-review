import type { DB } from "../db/connection.js";
import type { Unit } from "../types.js";
import { randomId } from "../util.js";

interface UnitRow {
  id: string; session_id: string; position: number; label: string;
  rationale: string; entry_point_node_ids: string;
}

function rowToUnit(row: UnitRow): Unit {
  return {
    id: row.id, sessionId: row.session_id, position: row.position,
    label: row.label, rationale: row.rationale,
    entryPointNodeIds: JSON.parse(row.entry_point_node_ids),
  };
}

export function createUnit(
  db: DB, sessionId: string, position: number, label: string,
  rationale: string, entryPointNodeIds: string[]
): Unit {
  const id = randomId("unit");
  db.prepare(
    "INSERT INTO units (id, session_id, position, label, rationale, entry_point_node_ids) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, sessionId, position, label, rationale, JSON.stringify(entryPointNodeIds));
  return { id, sessionId, position, label, rationale, entryPointNodeIds };
}

export function getUnitsBySession(db: DB, sessionId: string): Unit[] {
  const rows = db.prepare("SELECT * FROM units WHERE session_id = ? ORDER BY position").all(sessionId) as UnitRow[];
  return rows.map(rowToUnit);
}

export function updateUnit(db: DB, id: string, label: string, rationale: string, entryPointNodeIds: string[]): void {
  db.prepare("UPDATE units SET label = ?, rationale = ?, entry_point_node_ids = ? WHERE id = ?")
    .run(label, rationale, JSON.stringify(entryPointNodeIds), id);
}

export function deleteUnit(db: DB, id: string): void {
  db.prepare("DELETE FROM units WHERE id = ?").run(id);
}
