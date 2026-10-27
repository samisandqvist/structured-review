import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import type { AppContext } from "../context.js";
import { getSession } from "../repo/sessions.js";
import { getMap, saveMap } from "../repo/maps.js";
import { IndexError, sourceReader } from "../graph/scip.js";
import { findMarkerRoots } from "../graph/roots.js";
import type { ReferenceIndex } from "../graph/references.js";
import { loadComponentMap } from "../component-map.js";
import { buildEvidence } from "../map/evidence.js";
import { checkMap } from "../map/check.js";
import { snapshot, staleness } from "../staleness.js";

type Handler = (c: Context, sessionId: string, index: ReferenceIndex) => Promise<Response> | Response;

/** The component map of a session: evidence for the LLM, a dry-run check,
 *  submit (stored only when the fidelity check passes) and read. The map
 *  covers the whole indexed working tree; the session scopes storage and
 *  staleness. */
export function createMapRoute(ctx: AppContext) {
  const router = new Hono();
  const root = ctx.repoRoot!;
  const fileExists = (file: string) => existsSync(join(root, file));

  const withIndex = (handler: Handler) => async (c: Context) => {
    const sessionId = c.req.param("id")!;
    if (!getSession(ctx.db, sessionId)) return c.json({ error: "not found" }, 404);
    if (!ctx.graphProvider.getReferenceIndex) {
      return c.json(
        {
          error: `component maps need the scip graph provider (current: ${ctx.providerName ?? "unknown"})`,
          phase: "map",
        },
        400,
      );
    }
    try {
      return await handler(c, sessionId, await ctx.graphProvider.getReferenceIndex());
    } catch (e) {
      if (e instanceof IndexError) return c.json({ error: e.message, phase: e.phase }, 400);
      throw e;
    }
  };

  router.get(
    "/:id/map/evidence",
    withIndex((c, _sessionId, index) => {
      const within = c.req.query("within");
      const full = ["1", "true"].includes(c.req.query("full") ?? "");
      const evidence = buildEvidence(
        index,
        { readSource: sourceReader(root), roots: findMarkerRoots(root), manifest: loadComponentMap(root) },
        { full, ...(within ? { within } : {}) },
      );
      return c.json(evidence);
    }),
  );

  router.post(
    "/:id/map/check",
    withIndex(async (c, _sessionId, index) => {
      const body = await jsonBody(c);
      if (body === undefined) return badBody(c);
      return c.json({ report: checkMap(body, index, fileExists).map.report });
    }),
  );

  router.put(
    "/:id/map",
    withIndex(async (c, sessionId, index) => {
      const body = await jsonBody(c);
      if (body === undefined) return badBody(c);
      const { model, map } = checkMap(body, index, fileExists);
      if (!map.report.ok) return c.json({ error: "the map fails the fidelity check", report: map.report }, 422);
      saveMap(ctx.db, sessionId, { model, map, ...snapshot(root) });
      return c.json({ report: map.report });
    }),
  );

  router.get("/:id/map", (c) => {
    if (!getSession(ctx.db, c.req.param("id"))) return c.json({ error: "not found" }, 404);
    const stored = getMap(ctx.db, c.req.param("id"));
    if (!stored) return c.json({ error: "no component map for this session" }, 404);
    return c.json({
      model: stored.model,
      map: stored.map,
      headSha: stored.headSha,
      createdAt: stored.createdAt,
      ...staleness(root, stored.headSha, stored.repoFingerprint),
    });
  });

  return router;
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

const badBody = (c: Context) => c.json({ error: "the request body must be a JSON component model" }, 400);
