import type { DB } from "../db/connection.js";
import type { Comment, CommentAnchor, ExportedComment, Node } from "../types.js";
import { randomId } from "../util.js";
import { getNodeNeighbors } from "./nodes.js";

interface CommentRow {
  id: string;
  session_id: string;
  node_id: string | null;
  hunk_snippet: string;
  text: string;
  structural_context: string;
  created_at: number;
  anchor: string | null;
}

function rowToComment(row: CommentRow): Comment {
  return {
    id: row.id,
    sessionId: row.session_id,
    nodeId: row.node_id,
    hunkSnippet: row.hunk_snippet,
    text: row.text,
    structuralContext: row.structural_context,
    createdAt: row.created_at,
    anchor: row.anchor ? (JSON.parse(row.anchor) as CommentAnchor) : null,
  };
}

export function createComment(
  db: DB,
  sessionId: string,
  nodeId: string | null,
  hunkSnippet: string,
  text: string,
  structuralContext: string,
  anchor: CommentAnchor | null = null,
): Comment {
  const id = randomId("cmt");
  const createdAt = Date.now();
  db.prepare(
    "INSERT INTO comments (id, session_id, node_id, hunk_snippet, text, structural_context, created_at, anchor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, sessionId, nodeId, hunkSnippet, text, structuralContext, createdAt, anchor ? JSON.stringify(anchor) : null);
  return { id, sessionId, nodeId, hunkSnippet, text, structuralContext, createdAt, anchor };
}

export function getCommentsBySession(db: DB, sessionId: string): Comment[] {
  // rowid tie-break: same-millisecond comments still come back in insertion order.
  return (
    db.prepare("SELECT * FROM comments WHERE session_id = ? ORDER BY created_at, rowid").all(sessionId) as CommentRow[]
  ).map(rowToComment);
}

export function getComment(db: DB, id: string): Comment | undefined {
  const row = db.prepare("SELECT * FROM comments WHERE id = ?").get(id) as CommentRow | undefined;
  return row ? rowToComment(row) : undefined;
}

/** Text is the only editable field: anchor and snippet still describe the
 *  same lines, and createdAt keeps the comment's place in the export order. */
export function updateCommentText(db: DB, id: string, text: string): Comment | undefined {
  db.prepare("UPDATE comments SET text = ? WHERE id = ?").run(text, id);
  return getComment(db, id);
}

export function deleteComment(db: DB, id: string): boolean {
  return db.prepare("DELETE FROM comments WHERE id = ?").run(id).changes > 0;
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
  // LEFT JOIN: a NULL node_id is a session-wide comment and must survive the
  // export — it maps to a PR review body rather than an inline comment.
  const rows = db
    .prepare(
      `SELECT c.id, c.node_id, n.stable_id, n.label, n.file, n.start_line, n.end_line, c.hunk_snippet, c.text, c.structural_context, c.created_at, c.anchor
     FROM comments c LEFT JOIN nodes n ON c.node_id = n.id WHERE c.session_id = ? ORDER BY c.created_at, c.rowid`,
    )
    .all(sessionId) as {
    id: string;
    node_id: string | null;
    stable_id: string | null;
    label: string | null;
    file: string | null;
    start_line: number | null;
    end_line: number | null;
    hunk_snippet: string;
    text: string;
    structural_context: string;
    created_at: number;
    anchor: string | null;
  }[];
  return rows.map((row): ExportedComment => {
    if (row.node_id === null) {
      return { scope: "session", id: row.id, text: row.text, createdAt: row.created_at };
    }
    return {
      scope: "node",
      id: row.id,
      nodeId: row.node_id,
      stableId: row.stable_id!,
      label: row.label!,
      file: row.file!,
      startLine: row.start_line!,
      endLine: row.end_line!,
      hunkSnippet: row.hunk_snippet,
      text: row.text,
      structuralContext: structuralContextFor(db, row.node_id),
      createdAt: row.created_at,
      anchor: row.anchor ? (JSON.parse(row.anchor) as CommentAnchor) : null,
    };
  });
}
