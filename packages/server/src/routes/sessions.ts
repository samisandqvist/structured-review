import { Hono } from "hono";
import type { AppContext } from "../app.js";
import { createSession, getSession, updateSessionStatus } from "../repo/sessions.js";
import { createUnit, getUnitsBySession, deleteUnit } from "../repo/units.js";
import { createNode, getNodesBySession } from "../repo/nodes.js";
import { randomId } from "../util.js";

export function createSessionsRoute(ctx: AppContext) {
  const router = new Hono();

  router.post("/", async (c) => {
    const body = await c.req.json<{ branch: string; baseRef: string }>();
    const session = createSession(ctx.db, body.branch, body.baseRef);
    const subgraph = await ctx.graphProvider.getChangeSubgraph(body.branch, body.baseRef);
    for (const gnode of subgraph.nodes) {
      createNode(ctx.db, {
        sessionId: session.id, stableId: gnode.stableId, unitId: null,
        label: gnode.label, file: gnode.file, startLine: gnode.startLine, endLine: gnode.endLine,
        changeStatus: gnode.changeStatus, reviewStatus: "unreviewed", reviewedInUnit: null,
      });
    }
    const nodes = getNodesBySession(ctx.db, session.id);
    for (const gedge of subgraph.edges) {
      const source = nodes.find(n => n.stableId === gedge.sourceStableId);
      const target = nodes.find(n => n.stableId === gedge.targetStableId);
      if (source && target) {
        ctx.db.prepare(
          "INSERT INTO edges (id, session_id, source_node_id, target_node_id, edge_type) VALUES (?, ?, ?, ?, ?)"
        ).run(randomId("edge"), session.id, source.id, target.id, gedge.edgeType);
      }
    }
    return c.json({ session, subgraph });
  });

  router.get("/:id", (c) => {
    const session = getSession(ctx.db, c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    const units = getUnitsBySession(ctx.db, session.id);
    return c.json({ session, units });
  });

  router.put("/:id/plan", async (c) => {
    const sessionId = c.req.param("id");
    const session = getSession(ctx.db, sessionId);
    if (!session) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{
      units: { label: string; rationale: string; entryPointNodeIds: string[] }[];
    }>();
    for (const u of getUnitsBySession(ctx.db, sessionId)) deleteUnit(ctx.db, u.id);
    const created = body.units.map((u, i) =>
      createUnit(ctx.db, sessionId, i, u.label, u.rationale, u.entryPointNodeIds)
    );
    updateSessionStatus(ctx.db, sessionId, "walking");
    return c.json({ units: created });
  });

  return router;
}
