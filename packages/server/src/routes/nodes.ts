import { Hono } from "hono";
import type { AppContext } from "../app.js";
import type { ReviewStatus } from "../types.js";
import { getNodesBySession, getNodesByUnit, getNode, getNodeNeighbors, updateNodeReviewStatus } from "../repo/nodes.js";

export function createNodesRoute(ctx: AppContext) {
  const router = new Hono();

  router.get("/:id/nodes", (c) => {
    const sessionId = c.req.param("id");
    const unitId = c.req.query("unitId");
    const nodes = unitId ? getNodesByUnit(ctx.db, unitId) : getNodesBySession(ctx.db, sessionId);
    const edges = ctx.db
      .prepare("SELECT source_node_id, target_node_id FROM edges WHERE session_id = ?")
      .all(sessionId) as { source_node_id: string; target_node_id: string }[];
    return c.json({
      nodes,
      edges: edges.map((e) => ({ sourceNodeId: e.source_node_id, targetNodeId: e.target_node_id })),
    });
  });

  router.get("/:id/nodes/:nodeId", (c) => {
    const node = getNode(ctx.db, c.req.param("nodeId"));
    if (!node || node.sessionId !== c.req.param("id")) return c.json({ error: "not found" }, 404);
    const { callers, callees } = getNodeNeighbors(ctx.db, node.id);
    return c.json({ node, callers, callees });
  });

  router.patch("/:id/nodes/:nodeId", async (c) => {
    const body = await c.req.json<{ reviewStatus: ReviewStatus; reviewedInUnit?: number }>();
    const nodeId = c.req.param("nodeId");
    const existing = getNode(ctx.db, nodeId);
    if (!existing || existing.sessionId !== c.req.param("id")) return c.json({ error: "not found" }, 404);
    updateNodeReviewStatus(ctx.db, nodeId, body.reviewStatus, body.reviewedInUnit);
    const node = getNode(ctx.db, nodeId);
    if (!node) return c.json({ error: "not found" }, 404);
    return c.json({ node });
  });

  return router;
}
