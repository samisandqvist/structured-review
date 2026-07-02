import type { DB } from "../db/connection.js";
import type { Unit, UnitKind } from "../types.js";
import { randomId } from "../util.js";

interface UnitRow {
  id: string; session_id: string; position: number; label: string;
  rationale: string; kind: UnitKind; member_stable_ids: string; auto: number;
}

function rowToUnit(row: UnitRow): Unit {
  return {
    id: row.id, sessionId: row.session_id, position: row.position,
    label: row.label, rationale: row.rationale, kind: row.kind,
    memberStableIds: JSON.parse(row.member_stable_ids), auto: row.auto === 1,
  };
}

export function createUnit(
  db: DB, sessionId: string, position: number, label: string,
  rationale: string, kind: UnitKind, memberStableIds: string[], auto: boolean
): Unit {
  const id = randomId("unit");
  db.prepare(
    "INSERT INTO units (id, session_id, position, label, rationale, kind, member_stable_ids, auto) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, sessionId, position, label, rationale, kind, JSON.stringify(memberStableIds), auto ? 1 : 0);
  return { id, sessionId, position, label, rationale, kind, memberStableIds, auto };
}

export function getUnitsBySession(db: DB, sessionId: string): Unit[] {
  const rows = db.prepare("SELECT * FROM units WHERE session_id = ? ORDER BY position").all(sessionId) as UnitRow[];
  return rows.map(rowToUnit);
}

export function deleteUnit(db: DB, id: string): void {
  db.prepare("DELETE FROM units WHERE id = ?").run(id);
}
