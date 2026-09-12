import type { DB } from "../db/connection.js";
import type { ReviewSession, SessionStatus } from "../types.js";
import { randomId } from "../util.js";

export function createSession(
  db: DB,
  branch: string,
  baseRef: string,
  headSha = "",
  repoFingerprint = "",
  indexWarnings: string[] = [],
): ReviewSession {
  const id = randomId("ses");
  const createdAt = Date.now();
  db.prepare(
    "INSERT INTO review_sessions (id, branch, base_ref, status, created_at, head_sha, repo_fingerprint, index_warnings) VALUES (?, ?, ?, 'planning', ?, ?, ?, ?)",
  ).run(id, branch, baseRef, createdAt, headSha, repoFingerprint, JSON.stringify(indexWarnings));
  return { id, branch, baseRef, status: "planning", createdAt, headSha, repoFingerprint, indexWarnings, overview: "" };
}

interface SessionRow {
  id: string;
  branch: string;
  base_ref: string;
  status: SessionStatus;
  created_at: number;
  head_sha: string;
  repo_fingerprint: string;
  index_warnings: string;
  overview: string;
}

function rowToSession(row: SessionRow): ReviewSession {
  return {
    id: row.id,
    branch: row.branch,
    baseRef: row.base_ref,
    status: row.status,
    createdAt: row.created_at,
    headSha: row.head_sha,
    repoFingerprint: row.repo_fingerprint,
    indexWarnings: JSON.parse(row.index_warnings) as string[],
    overview: row.overview,
  };
}

export function getSession(db: DB, id: string): ReviewSession | undefined {
  const row = db.prepare("SELECT * FROM review_sessions WHERE id = ?").get(id) as SessionRow | undefined;
  return row ? rowToSession(row) : undefined;
}

export function listSessions(db: DB): ReviewSession[] {
  return (db.prepare("SELECT * FROM review_sessions ORDER BY created_at DESC").all() as SessionRow[]).map(rowToSession);
}

/** Cascades to units/nodes/edges/comments via ON DELETE CASCADE. */
export function deleteSession(db: DB, id: string): boolean {
  return db.prepare("DELETE FROM review_sessions WHERE id = ?").run(id).changes > 0;
}

export function updateSessionStatus(db: DB, id: string, status: SessionStatus): void {
  db.prepare("UPDATE review_sessions SET status = ? WHERE id = ?").run(status, id);
}

export function updateSessionOverview(db: DB, id: string, overview: string): void {
  db.prepare("UPDATE review_sessions SET overview = ? WHERE id = ?").run(overview, id);
}
