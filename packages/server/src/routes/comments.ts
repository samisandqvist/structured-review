import { Hono } from "hono";
import type { AppContext } from "../app.js";
import { createComment, getCommentsBySession, exportComments } from "../repo/comments.js";
import { getSession } from "../repo/sessions.js";
import { getNode } from "../repo/nodes.js";
import { getNodeDiff, formatHunkSnippet } from "../diff.js";
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
    const node = getNode(ctx.db, body.nodeId);
    if (!node || node.sessionId !== sessionId) return c.json({ error: "node not found in session" }, 404);
    // The snippet is derived server-side from what the diff pane shows for this
    // node right now — client-authored context is not trusted (findings doc).
    const diff = getNodeDiff(session.baseRef, node.file, node.startLine, node.endLine, node.changeStatus, ctx.repoRoot);
    const comment = createComment(ctx.db, sessionId, body.nodeId, formatHunkSnippet(diff.lines), body.text, "");
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
