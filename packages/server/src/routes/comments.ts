import { Hono } from "hono";
import type { AppContext } from "../app.js";
import { createComment, getCommentsBySession, exportComments } from "../repo/comments.js";
import { getSession } from "../repo/sessions.js";
import { getNode } from "../repo/nodes.js";
import { getNodeDiff, getNodeDiffForRanges, formatHunkSnippet, anchorRowRange } from "../diff.js";
import type { CommentAnchor } from "../types.js";
import { parseBody, commentCreateSchema } from "../validate.js";

export function createCommentsRoute(ctx: AppContext) {
  const router = new Hono();

  router.get("/:id/comments", (c) => {
    return c.json({ comments: getCommentsBySession(ctx.db, c.req.param("id")) });
  });

  router.post("/:id/comments", async (c) => {
    const sessionId = c.req.param("id");
    const parsed = await parseBody(c, commentCreateSchema);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;
    const session = getSession(ctx.db, sessionId);
    if (!session) return c.json({ error: "not found" }, 404);
    if (!body.nodeId) {
      // Session-wide comment: nothing to anchor, no snippet to derive.
      return c.json({ comment: createComment(ctx.db, sessionId, null, "", body.text, "") });
    }
    const node = getNode(ctx.db, body.nodeId);
    if (!node || node.sessionId !== sessionId) return c.json({ error: "node not found in session" }, 404);
    // The snippet is derived server-side from what the diff pane shows for this
    // node right now — client-authored context is not trusted (findings doc).
    // Same residual-aware diff derivation the diff pane uses (routes/nodes.ts) —
    // the anchor must validate against exactly what the reviewer sees.
    const diff =
      (node.residualRanges && node.residualRanges.length > 0
        ? getNodeDiffForRanges(session.baseRef, node.file, node.residualRanges, ctx.repoRoot)
        : null) ?? getNodeDiff(session.baseRef, node.file, node.startLine, node.endLine, node.changeStatus, ctx.repoRoot);

    let snippetLines = diff.lines;
    let anchor: CommentAnchor | null = null;
    if (body.anchor) {
      const range = anchorRowRange(diff.lines, body.anchor);
      if (!range) {
        return c.json({ error: "anchor does not resolve to changed lines in this node's current diff" }, 400);
      }
      anchor = body.anchor;
      snippetLines = diff.lines.slice(range.startIdx, range.endIdx + 1);
    }
    const comment = createComment(ctx.db, sessionId, body.nodeId, formatHunkSnippet(snippetLines), body.text, "", anchor);
    return c.json({ comment });
  });

  router.get("/:id/export", (c) => {
    const session = getSession(ctx.db, c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    return c.json({
      branch: session.branch,
      baseRef: session.baseRef,
      headSha: session.headSha,
      comments: exportComments(ctx.db, session.id),
    });
  });

  return router;
}
