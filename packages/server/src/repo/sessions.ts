import type { DB } from "../db/connection.js";
import type { ReviewSession, SessionStatus } from "../types.js";
import { randomId } from "../util.js";

export function createSession(db: DB, branch: string, baseRef: string, headSha = "", repoFingerprint = ""): ReviewSession {
  const id = randomId("ses");
  const createdAt = Date.now();
  db.prepare(
    "INSERT INTO review_sessions (id, branch, base_ref, status, created_at, head_sha, repo_fingerprint) VALUES (?, ?, ?, 'planning', ?, ?, ?)"
  ).run(id, branch, baseRef, createdAt, headSha, repoFingerprint);
  return { id, branch, baseRef, status: "planning", createdAt, headSha, repoFingerprint };
}

export function getSession(db: DB, id: string): ReviewSession | undefined {
  const row = db.prepare("SELECT * FROM review_sessions WHERE id = ?").get(id) as
    | { id: string; branch: string; base_ref: string; status: SessionStatus; created_at: number; head_sha: string; repo_fingerprint: string }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id, branch: row.branch, baseRef: row.base_ref, status: row.status,
    createdAt: row.created_at, headSha: row.head_sha, repoFingerprint: row.repo_fingerprint,
  };
}

export function updateSessionStatus(db: DB, id: string, status: SessionStatus): void {
  db.prepare("UPDATE review_sessions SET status = ? WHERE id = ?").run(status, id);
}
