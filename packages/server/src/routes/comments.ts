import { Hono } from "hono";
import type { AppContext } from "../app.js";
import { createComment, getCommentsBySession, exportComments } from "../repo/comments.js";

export function createCommentsRoute(ctx: AppContext) {
  const router = new Hono();

  router.get("/:id/comments", (c) => {
    return c.json({ comments: getCommentsBySession(ctx.db, c.req.param("id")) });
  });

  router.post("/:id/comments", async (c) => {
    const body = await c.req.json<{
      nodeId: string; hunkSnippet: string; text: string; structuralContext: string;
    }>();
    const comment = createComment(ctx.db, c.req.param("id"), body.nodeId, body.hunkSnippet, body.text, body.structuralContext);
    return c.json({ comment });
  });

  router.get("/:id/export", (c) => {
    return c.json(exportComments(ctx.db, c.req.param("id")));
  });

  return router;
}
