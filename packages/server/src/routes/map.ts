import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import type { AppContext } from "../context.js";
import { diffBase, getSession } from "../repo/sessions.js";
import { getNodesBySession } from "../repo/nodes.js";
import { getMap, saveMap } from "../repo/maps.js";
import { IndexError, sourceReader } from "../graph/scip.js";
import { findMarkerRoots } from "../graph/roots.js";
import type { ReferenceIndex } from "../graph/references.js";
import { changedFileStatuses, fileChangedRanges, GitError, type LineRange } from "../diff.js";
import { loadComponentMap } from "../component-map.js";
import { buildEvidence } from "../map/evidence.js";
import { checkMap } from "../map/check.js";
import { objectType } from "../map/base.js";
import { compareVersions } from "../map/change.js";
import type { MapModel, ResolvedMap } from "../map/types.js";
import type { ReviewSession } from "../types.js";
import { snapshot, staleness } from "../staleness.js";

/** The code a map is built from: the session's base checkout in a review
 *  session (`baseSha` set), otherwise the working tree. */
interface MapSource {
  root: string;
  index: ReferenceIndex;
  baseSha?: string;
}

type Handler = (c: Context, session: ReviewSession, source: MapSource) => Promise<Response> | Response;

/** The component map of a session: evidence for the LLM, a dry-run check,
 *  submit (stored only when the fidelity check passes) and read. A review
 *  session's map is built from its base commit and carries the change to the
 *  working tree; a whole-repository session maps the working tree. */
export function createMapRoute(ctx: AppContext) {
  const router = new Hono();
  const root = ctx.repoRoot!;
  const fileExistsIn = (dir: string) => (file: string) => existsSync(join(dir, file));

  const withSource = (handler: Handler) => async (c: Context) => {
    const session = getSession(ctx.db, c.req.param("id")!);
    if (!session) return c.json({ error: "not found" }, 404);
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
      return await handler(c, session, await mapSource(ctx, session));
    } catch (e) {
      if (e instanceof IndexError || e instanceof GitError) return c.json({ error: e.message, phase: e.phase }, 400);
      throw e;
    }
  };

  router.get(
    "/:id/map/evidence",
    withSource((c, _session, source) => {
      const within = c.req.query("within");
      const full = ["1", "true"].includes(c.req.query("full") ?? "");
      const evidence = buildEvidence(
        source.index,
        {
          readSource: sourceReader(source.root),
          roots: findMarkerRoots(source.root),
          manifest: loadComponentMap(source.root),
        },
        { full, ...(within ? { within } : {}) },
      );
      return c.json(source.baseSha ? { ...evidence, baseSha: source.baseSha } : evidence);
    }),
  );

  router.post(
    "/:id/map/check",
    withSource(async (c, _session, source) => {
      const body = await jsonBody(c);
      if (body === undefined) return badBody(c);
      return c.json({ report: checkMap(body, source.index, fileExistsIn(source.root)).map.report });
    }),
  );

  router.put(
    "/:id/map",
    withSource(async (c, session, source) => {
      const body = await jsonBody(c);
      if (body === undefined) return badBody(c);
      const { model, map } = checkMap(body, source.index, fileExistsIn(source.root));
      if (!map.report.ok) return c.json({ error: "the map fails the fidelity check", report: map.report }, 422);
      const stored = await withChange(ctx, session, source, { model, base: map });
      saveMap(ctx.db, session.id, { model, map: stored, ...snapshot(root) });
      return c.json({ report: map.report, ...(stored.change ? { change: stored.change } : {}) });
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

const headIndex = (ctx: AppContext) => ctx.graphProvider.getReferenceIndex!();

async function mapSource(ctx: AppContext, session: ReviewSession): Promise<MapSource> {
  const root = ctx.repoRoot!;
  const sha = diffBase(session);
  const type = objectType(sha, root);
  if (type === null) throw new GitError("base-checkout", `the session's base ${sha} is not in the repository`);
  if (ctx.bases && type === "commit") return { ...(await ctx.bases.get(session.id, root, sha)), baseSha: sha };
  return { root, index: await headIndex(ctx) };
}

/** The checked base map, with the change to the working tree in a review session. */
async function withChange(
  ctx: AppContext,
  session: ReviewSession,
  source: MapSource,
  checked: { model: MapModel; base: ResolvedMap },
): Promise<ResolvedMap> {
  if (!source.baseSha) return checked.base;
  const root = ctx.repoRoot!;
  const sha = source.baseSha;
  const ranges = new Map<string, LineRange[]>();
  const changedLines = (file: string) => {
    if (!ranges.has(file)) ranges.set(file, fileChangedRanges(sha, file, root) ?? []);
    return ranges.get(file)!;
  };
  const nodes = getNodesBySession(ctx.db, session.id).map((n) => ({
    id: n.id,
    file: n.file,
    startLine: n.startLine,
    endLine: n.endLine,
    isTest: n.isTest,
    residual: (n.residualRanges?.length ?? 0) > 0,
    changed: n.changeStatus === "changed",
  }));
  const files = changedFileStatuses(sha, root) ?? [];
  const head = await headIndex(ctx);
  return { ...checked.base, change: compareVersions({ ...checked, head, nodes, files, changedLines }, sha) };
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

const badBody = (c: Context) => c.json({ error: "the request body must be a JSON component model" }, 400);
