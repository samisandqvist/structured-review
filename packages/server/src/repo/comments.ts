import type { DB } from "../db/connection.js";
import type { Comment, ExportedComment } from "../types.js";
import { randomId } from "../util.js";

interface CommentRow {
  id: string; session_id: string; node_id: string; hunk_snippet: string;
  text: string; structural_context: string; created_at: number;
}

function rowToComment(row: CommentRow): Comment {
  return {
    id: row.id, sessionId: row.session_id, nodeId: row.node_id,
    hunkSnippet: row.hunk_snippet, text: row.text,
    structuralContext: row.structural_context, createdAt: row.created_at,
  };
}

export function createComment(
  db: DB, sessionId: string, nodeId: string, hunkSnippet: string,
  text: string, structuralContext: string
): Comment {
  const id = randomId("cmt");
  const createdAt = Date.now();
  db.prepare(
    "INSERT INTO comments (id, session_id, node_id, hunk_snippet, text, structural_context, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, sessionId, nodeId, hunkSnippet, text, structuralContext, createdAt);
  return { id, sessionId, nodeId, hunkSnippet, text, structuralContext, createdAt };
}

export function getCommentsBySession(db: DB, sessionId: string): Comment[] {
  return (db.prepare("SELECT * FROM comments WHERE session_id = ? ORDER BY created_at").all(sessionId) as CommentRow[]).map(rowToComment);
}

export function exportComments(db: DB, sessionId: string): Record<string, ExportedComment> {
  const rows = db.prepare(
    `SELECT c.node_id, n.stable_id, n.label, n.file, c.hunk_snippet, c.text, c.structural_context, c.created_at
     FROM comments c JOIN nodes n ON c.node_id = n.id WHERE c.session_id = ? ORDER BY c.created_at`
  ).all(sessionId) as {
    node_id: string; stable_id: string; label: string; file: string;
    hunk_snippet: string; text: string; structural_context: string; created_at: number;
  }[];
  const result: Record<string, ExportedComment> = {};
  for (const row of rows) {
    result[row.node_id] = {
      nodeId: row.node_id, stableId: row.stable_id, label: row.label, file: row.file,
      hunkSnippet: row.hunk_snippet, text: row.text,
      structuralContext: row.structural_context, createdAt: row.created_at,
    };
  }
  return result;
}
