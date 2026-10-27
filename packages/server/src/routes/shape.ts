import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { getSession, diffBase } from "../repo/sessions.js";
import { changedFileStatuses, directoryExistsAt } from "../diff.js";
import { loadComponentMap } from "../component-map.js";
import { buildChangeShape } from "../change-shape.js";

/** The change's shape against the repository's components, computed from the
 *  current working tree and the session's base on every request. */
export function createShapeRoute(ctx: AppContext) {
  const router = new Hono();

  router.get("/:id/shape", (c) => {
    const session = getSession(ctx.db, c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    const root = ctx.repoRoot!;
    const changes = changedFileStatuses(diffBase(session), root);
    if (!changes) return c.json({ error: `cannot list changes against ${session.baseRef}`, phase: "list-files" }, 500);
    const shape = buildChangeShape(changes, loadComponentMap(root), (dir) =>
      directoryExistsAt(diffBase(session), dir, root),
    );
    return c.json(shape);
  });

  return router;
}
