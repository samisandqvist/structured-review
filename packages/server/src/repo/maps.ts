import type { DB } from "../db/connection.js";
import type { MapModel, ResolvedMap } from "../map/types.js";

export interface StoredMap {
  model: MapModel;
  map: ResolvedMap;
  headSha: string;
  repoFingerprint: string;
  createdAt: number;
}

interface MapRow {
  model: string;
  resolved: string;
  head_sha: string;
  repo_fingerprint: string;
  created_at: number;
}

/** Stores the session's map, replacing any earlier one. */
export function saveMap(db: DB, sessionId: string, record: Omit<StoredMap, "createdAt">): void {
  db.prepare(
    "INSERT OR REPLACE INTO component_maps (session_id, model, resolved, head_sha, repo_fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    sessionId,
    JSON.stringify(record.model),
    JSON.stringify(record.map),
    record.headSha,
    record.repoFingerprint,
    Date.now(),
  );
}

export function getMap(db: DB, sessionId: string): StoredMap | undefined {
  const row = db.prepare("SELECT * FROM component_maps WHERE session_id = ?").get(sessionId) as MapRow | undefined;
  if (!row) return undefined;
  return {
    model: JSON.parse(row.model) as MapModel,
    map: JSON.parse(row.resolved) as ResolvedMap,
    headSha: row.head_sha,
    repoFingerprint: row.repo_fingerprint,
    createdAt: row.created_at,
  };
}
