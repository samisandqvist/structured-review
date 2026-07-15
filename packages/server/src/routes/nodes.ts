import { Hono } from "hono";
import type { AppContext } from "../app.js";
import { getNodesBySession, getNode, getNodeNeighbors, updateNodeReviewStatus } from "../repo/nodes.js";
import { getSession } from "../repo/sessions.js";
import { nodeHasComments } from "../repo/comments.js";
import { getNodeDiff, getNodeDiffForRanges } from "../diff.js";
import { parseBody, nodePatchSchema } from "../validate.js";

export function createNodesRoute(ctx: AppContext) {
  const router = new Hono();

  router.get("/:id/nodes", (c) => {
    const sessionId = c.req.param("id");
    const nodes = getNodesBySession(ctx.db, sessionId);
    const edges = ctx.db
      .prepare("SELECT source_node_id, target_node_id, edge_type FROM edges WHERE session_id = ?")
      .all(sessionId) as { source_node_id: string; target_node_id: string; edge_type: string }[];
    return c.json({
      nodes,
      edges: edges.map((e) => ({ sourceNodeId: e.source_node_id, targetNodeId: e.target_node_id, edgeType: e.edge_type })),
    });
  });

  router.get("/:id/nodes/:nodeId", (c) => {
    const sessionId = c.req.param("id");
    const node = getNode(ctx.db, c.req.param("nodeId"));
    if (!node || node.sessionId !== sessionId) return c.json({ error: "not found" }, 404);
    const { callers, callees } = getNodeNeighbors(ctx.db, node.id);
    const session = getSession(ctx.db, sessionId);
    const diff = session
      ? (node.residualRanges && node.residualRanges.length > 0
          ? getNodeDiffForRanges(session.baseRef, node.file, node.residualRanges, ctx.repoRoot) ??
            getNodeDiff(session.baseRef, node.file, node.startLine, node.endLine, node.changeStatus, ctx.repoRoot)
          : getNodeDiff(session.baseRef, node.file, node.startLine, node.endLine, node.changeStatus, ctx.repoRoot))
      : { oldText: "", newText: "", lines: [] };
    return c.json({ node, callers, callees, diff });
  });

  router.patch("/:id/nodes/:nodeId", async (c) => {
    const parsed = await parseBody(c, nodePatchSchema);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;
    const nodeId = c.req.param("nodeId");
    const existing = getNode(ctx.db, nodeId);
    if (!existing || existing.sessionId !== c.req.param("id")) return c.json({ error: "not found" }, 404);
    const status = body.reviewStatus === "reviewed-clean" && nodeHasComments(ctx.db, nodeId)
      ? "reviewed-commented"
      : body.reviewStatus;
    updateNodeReviewStatus(ctx.db, nodeId, status, body.reviewedInUnit);
    const node = getNode(ctx.db, nodeId);
    if (!node) return c.json({ error: "not found" }, 404);
    return c.json({ node });
  });

  return router;
}
