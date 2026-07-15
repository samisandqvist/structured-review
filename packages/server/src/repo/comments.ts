import type { DB } from "../db/connection.js";
import type { Comment, ExportedComment, Node } from "../types.js";
import { randomId } from "../util.js";
import { getNodeNeighbors } from "./nodes.js";

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
  // rowid tie-break: same-millisecond comments still come back in insertion order.
  return (db.prepare("SELECT * FROM comments WHERE session_id = ? ORDER BY created_at, rowid").all(sessionId) as CommentRow[]).map(rowToComment);
}

export function nodeHasComments(db: DB, nodeId: string): boolean {
  const row = db.prepare("SELECT 1 FROM comments WHERE node_id = ? LIMIT 1").get(nodeId);
  return row !== undefined;
}

/** Derived at export time from stored session edges — never client-authored. */
export function structuralContextFor(db: DB, nodeId: string): string {
  const { callers, callees } = getNodeNeighbors(db, nodeId);
  const fmt = (n: Node) => `${n.label} (${n.file}:${n.startLine})`;
  const callerFns = callers.filter((n) => !n.isTest);
  const tests = callers.filter((n) => n.isTest);
  const parts: string[] = [];
  if (callerFns.length) parts.push(`called by: ${callerFns.map(fmt).join(", ")}`);
  if (callees.length) parts.push(`calls: ${callees.map(fmt).join(", ")}`);
  if (tests.length) parts.push(`tested by: ${tests.map(fmt).join(", ")}`);
  return parts.join("; ");
}

export function exportComments(db: DB, sessionId: string): ExportedComment[] {
  const rows = db.prepare(
    `SELECT c.id, c.node_id, n.stable_id, n.label, n.file, n.start_line, n.end_line, c.hunk_snippet, c.text, c.structural_context, c.created_at
     FROM comments c JOIN nodes n ON c.node_id = n.id WHERE c.session_id = ? ORDER BY c.created_at, c.rowid`
  ).all(sessionId) as {
    id: string; node_id: string; stable_id: string; label: string; file: string;
    start_line: number; end_line: number;
    hunk_snippet: string; text: string; structural_context: string; created_at: number;
  }[];
  return rows.map((row) => ({
    id: row.id, nodeId: row.node_id, stableId: row.stable_id, label: row.label, file: row.file,
    startLine: row.start_line, endLine: row.end_line,
    hunkSnippet: row.hunk_snippet, text: row.text,
    structuralContext: structuralContextFor(db, row.node_id),
    createdAt: row.created_at,
  }));
}
