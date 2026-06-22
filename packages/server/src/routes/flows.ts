import { Hono } from "hono";
import type { AppContext } from "../app.js";
import { getNodesBySession } from "../repo/nodes.js";

/**
 * EXPERIMENT: execution-flows view of a review. Lines CRG's traced flows up
 * against the session's nodes (by stableId), so each step carries the node's
 * change/review status and a flow is "affected" if it passes through a change.
 */
export function createFlowsRoute(ctx: AppContext) {
  const router = new Hono();

  router.get("/:id/flows", async (c) => {
    const nodes = getNodesBySession(ctx.db, c.req.param("id"));
    const byStable = new Map(nodes.map((n) => [n.stableId, n]));

    const allFlows = await ctx.graphProvider.getFlows();
    const flows = allFlows.map((f) => {
      let affected = false;
      const steps = f.steps.map((s) => {
        const node = byStable.get(s.stableId);
        if (node && node.changeStatus === "changed") affected = true;
        return {
          label: s.label,
          file: s.file,
          startLine: s.startLine,
          endLine: s.endLine,
          isTest: s.isTest,
          depth: s.depth,
          nodeId: node?.id ?? null,
          changeStatus: node?.changeStatus ?? null,
          reviewStatus: node?.reviewStatus ?? null,
        };
      });
      return { id: f.id, name: f.name, criticality: f.criticality, depth: f.depth, affected, steps };
    });

    // Affected flows first; criticality order is preserved within each group.
    flows.sort((a, b) => Number(b.affected) - Number(a.affected));
    return c.json({ flows });
  });

  return router;
}
