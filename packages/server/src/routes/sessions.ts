import { Hono } from "hono";
import type { AppContext } from "../app.js";
import { createSession, getSession, listSessions, deleteSession, updateSessionStatus } from "../repo/sessions.js";
import { createUnit, getUnitsBySession, deleteUnit, updateUnitLabel, setUnitPositions } from "../repo/units.js";
import { createNode, getNodesBySession } from "../repo/nodes.js";
import { fileChangedRanges, gitHeadSha, repoFingerprint, resolveRef, rangesOverlap, currentBranch, GitError, type LineRange } from "../diff.js";
import { IndexError } from "../graph/scip.js";
import { computeResiduals } from "../residuals.js";
import type { ChangeSubgraph, GraphNode } from "../graph/provider.js";
import type { ChangeStatus } from "../types.js";
import { computeCoverage, flowEntries } from "../coverage.js";
import { deriveAttachments, countedAttachmentIds } from "../attach.js";
import { randomId } from "../util.js";
import { parseBody, sessionCreateSchema, planSchema, unitPatchSchema } from "../validate.js";

/**
 * Turn a provider subgraph into the nodes we actually store:
 *  1. Refine change status — CRG flags nodes changed at file granularity, so a
 *     node stays "changed" only if a real diff hunk overlaps its line span.
 *  2. Prune context — keep changed nodes, tests, and unchanged nodes that are a
 *     direct call caller/callee of a changed node; drop the rest (impact radius
 *     pulls in disconnected siblings — other interface impls, test-only code).
 */
function reconcileSubgraph(
  subgraph: ChangeSubgraph,
  baseRef: string,
  root: string
): { nodes: GraphNode[]; status: Map<string, ChangeStatus> } {
  const rangesByFile = new Map<string, LineRange[] | null>();
  const status = new Map<string, ChangeStatus>();
  for (const n of subgraph.nodes) {
    let cs = n.changeStatus;
    if (cs === "changed") {
      if (!rangesByFile.has(n.file)) rangesByFile.set(n.file, fileChangedRanges(baseRef, n.file, root));
      const ranges = rangesByFile.get(n.file);
      if (ranges && ranges.length > 0 && !rangesOverlap(ranges, n.startLine, n.endLine)) cs = "unchanged";
    }
    status.set(n.stableId, cs);
  }

  // Anchor context on changed *production* nodes only: a changed test shouldn't
  // drag unchanged production code it happens to exercise into the graph (that
  // would also orphan such a node whenever tests are hidden).
  const isTest = new Map(subgraph.nodes.map((n) => [n.stableId, n.isTest]));
  const anchors = new Set(
    [...status].filter(([id, s]) => s === "changed" && !isTest.get(id)).map(([id]) => id)
  );
  const adj = new Set<string>();
  for (const e of subgraph.edges) {
    if (e.edgeType !== "call") continue;
    if (anchors.has(e.sourceStableId)) adj.add(e.targetStableId);
    if (anchors.has(e.targetStableId)) adj.add(e.sourceStableId);
  }
  const nodes = subgraph.nodes.filter(
    (n) => status.get(n.stableId) === "changed" || n.isTest || adj.has(n.stableId)
  );
  return { nodes, status };
}

export function createSessionsRoute(ctx: AppContext) {
  const router = new Hono();

  router.post("/", async (c) => {
    const parsed = await parseBody(c, sessionCreateSchema);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;

    // Fail loudly here: an unusable repo/baseRef must not silently produce an
    // empty-but-complete-looking session (see diff.ts changedFilesStrict).
    const headSha = gitHeadSha(ctx.repoRoot);
    if (!headSha) return c.json({ error: "not a git repository (or git unavailable)", phase: "resolve-ref" }, 400);
    if (!resolveRef(body.baseRef, ctx.repoRoot)) {
      return c.json({ error: `cannot resolve base ref '${body.baseRef}'`, phase: "resolve-ref" }, 400);
    }

    // The tool reviews the current working tree (SCIP indexes it directly),
    // so `branch` must name what's actually checked out — otherwise the
    // session would silently review the wrong tree.
    const checkedOut = currentBranch(ctx.repoRoot);
    if (body.branch !== "HEAD" && body.branch !== checkedOut) {
      return c.json({
        error: `session branch '${body.branch}' is not checked out (current: '${checkedOut ?? "unknown"}'); ` +
          `this tool reviews the current working tree — check the branch out or pass HEAD`,
        phase: "resolve-ref",
      }, 400);
    }

    // All git-dependent work happens before any row is written, so a GitError
    // mid-creation cannot leave an orphaned zero-node session behind.
    let subgraph: ChangeSubgraph;
    let keptNodes: GraphNode[];
    let status: Map<string, ChangeStatus>;
    let residuals: ReturnType<typeof computeResiduals>;
    let indexWarnings: string[] = [];
    try {
      subgraph = await ctx.graphProvider.getChangeSubgraph(body.branch, body.baseRef);
      ({ nodes: keptNodes, status } = reconcileSubgraph(subgraph, body.baseRef, ctx.repoRoot!));

      // Residual coverage: changed lines outside every node span become one
      // pseudo-node per file, so types/imports/configs still enter the universe.
      const spansByFile = new Map<string, LineRange[]>();
      for (const n of keptNodes) {
        const spans = spansByFile.get(n.file) ?? [];
        spans.push({ start: n.startLine, end: n.endLine });
        spansByFile.set(n.file, spans);
      }
      residuals = computeResiduals(body.baseRef, spansByFile, ctx.repoRoot!);
      indexWarnings = (await ctx.graphProvider.getIndexWarnings?.()) ?? [];
    } catch (e) {
      if (e instanceof GitError) return c.json({ error: e.message, phase: e.phase }, 400);
      if (e instanceof IndexError) return c.json({ error: e.message, phase: e.phase }, 400);
      throw e;
    }

    const session = ctx.db.transaction(() => {
      const session = createSession(ctx.db, body.branch, body.baseRef, headSha, repoFingerprint(ctx.repoRoot) ?? "", indexWarnings);
      for (const gnode of keptNodes) {
        createNode(ctx.db, {
          sessionId: session.id, stableId: gnode.stableId,
          label: gnode.label, file: gnode.file, startLine: gnode.startLine, endLine: gnode.endLine,
          changeStatus: status.get(gnode.stableId)!, reviewStatus: "unreviewed", reviewedInUnit: null,
          isTest: gnode.isTest,
        });
      }
      for (const r of residuals) {
        createNode(ctx.db, {
          sessionId: session.id, stableId: r.stableId,
          label: r.label, file: r.file, startLine: r.startLine, endLine: r.endLine,
          changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null,
          isTest: r.isTest, residualRanges: r.ranges, residualKind: r.kind,
        });
      }
      const idByStable = new Map(getNodesBySession(ctx.db, session.id).map((n) => [n.stableId, n.id]));
      const insertEdge = ctx.db.prepare(
        "INSERT INTO edges (id, session_id, source_node_id, target_node_id, edge_type) VALUES (?, ?, ?, ?, ?)"
      );
      for (const gedge of subgraph.edges) {
        const source = idByStable.get(gedge.sourceStableId);
        const target = idByStable.get(gedge.targetStableId);
        if (source && target) insertEdge.run(randomId("edge"), session.id, source, target, gedge.edgeType);
      }
      return session;
    })();
    return c.json({ session, subgraph });
  });

  router.get("/", (c) => c.json({ sessions: listSessions(ctx.db) }));

  router.delete("/:id", (c) => {
    const id = c.req.param("id");
    if (!deleteSession(ctx.db, id)) return c.json({ error: "not found" }, 404);
    return c.json({ deleted: id });
  });

  router.get("/:id", (c) => {
    const session = getSession(ctx.db, c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    const units = getUnitsBySession(ctx.db, session.id);
    const changed = getNodesBySession(ctx.db, session.id).filter((n) => n.changeStatus === "changed");
    const autoMembers = new Set(units.filter((u) => u.auto).flatMap((u) => u.memberStableIds));
    const unassigned = changed.filter((n) => autoMembers.has(n.stableId)).length;
    // Stale = the session snapshot no longer matches the working tree, either
    // because HEAD moved or a tracked/untracked file changed content (the
    // fingerprint catches edits that leave HEAD untouched). Omitted when git
    // (or the recorded state) is unavailable — degrade silently.
    const currentHead = gitHeadSha(ctx.repoRoot);
    const currentFp = repoFingerprint(ctx.repoRoot);
    let stale: boolean | undefined;
    let staleReason: "head-moved" | "working-tree-changed" | undefined;
    if (currentHead && session.headSha) {
      if (currentHead !== session.headSha) { stale = true; staleReason = "head-moved"; }
      else if (currentFp && session.repoFingerprint) {
        stale = currentFp !== session.repoFingerprint;
        if (stale) staleReason = "working-tree-changed";
      }
    }
    return c.json({
      session,
      units,
      coverage: { changedTotal: changed.length, covered: changed.length - unassigned, unassigned },
      ...(stale === undefined ? {} : { stale }),
      ...(staleReason ? { staleReason } : {}),
    });
  });

  router.put("/:id/plan", async (c) => {
    const sessionId = c.req.param("id");
    const session = getSession(ctx.db, sessionId);
    if (!session) return c.json({ error: "not found" }, 404);
    const parsed = await parseBody(c, planSchema);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;

    const sessionNodes = getNodesBySession(ctx.db, sessionId);
    const changedStableIds = sessionNodes
      .filter((n) => n.changeStatus === "changed")
      .map((n) => n.stableId);
    const flows = await ctx.graphProvider.getFlows(new Set(changedStableIds));
    const { unassigned } = computeCoverage(body.units, flows, changedStableIds);

    // Attachment derivation (spec 2026-07-17): nest unassigned tests, DTOs and
    // module-scope residuals under the covered node that gives them context.
    // Derived here (not on read) so web, CLI and coverage share one truth.
    const testEdges = (ctx.db.prepare(
      `SELECT sn.stable_id AS prod, tn.stable_id AS test
       FROM edges e JOIN nodes sn ON e.source_node_id = sn.id JOIN nodes tn ON e.target_node_id = tn.id
       WHERE e.session_id = ? AND e.edge_type = 'test'`
    ).all(sessionId) as { prod: string; test: string }[])
      .map((r) => ({ productionStableId: r.prod, testStableId: r.test }));
    const fileRequires = (await ctx.graphProvider.getFileRequires?.()) ?? new Map<string, Set<string>>();
    const attachedPerUnit = deriveAttachments(body.units, flows, sessionNodes, testEdges, fileRequires);
    const attachedIds = countedAttachmentIds(attachedPerUnit);
    const leftovers = unassigned.filter((id) => !attachedIds.has(id));

    ctx.db.transaction(() => {
      for (const u of getUnitsBySession(ctx.db, sessionId)) deleteUnit(ctx.db, u.id);
      let pos = 0;
      body.units.forEach((u, i) => {
        const members = u.kind === "flow" ? flowEntries(u) : (u.orphanStableIds ?? []);
        createUnit(ctx.db, sessionId, pos++, u.label, u.rationale ?? "", u.kind, members, false, attachedPerUnit[i]);
      });
      if (leftovers.length > 0) {
        createUnit(ctx.db, sessionId, pos++, "Unassigned changes",
          "Changes not covered by any chosen unit.", "orphans", leftovers, true);
      }
      updateSessionStatus(ctx.db, sessionId, "walking");
    })();

    const coverage = {
      changedTotal: changedStableIds.length,
      covered: changedStableIds.length - leftovers.length,
      unassigned: leftovers.length,
    };
    return c.json({ units: getUnitsBySession(ctx.db, sessionId), coverage });
  });

  router.patch("/:id/units/:unitId", async (c) => {
    const sessionId = c.req.param("id");
    if (!getSession(ctx.db, sessionId)) return c.json({ error: "not found" }, 404);
    const units = getUnitsBySession(ctx.db, sessionId);
    const unit = units.find((u) => u.id === c.req.param("unitId"));
    if (!unit) return c.json({ error: "not found" }, 404);
    if (unit.auto) return c.json({ error: "auto unit is not editable" }, 400);
    const parsed = await parseBody(c, unitPatchSchema);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;
    if (body.label !== undefined) updateUnitLabel(ctx.db, unit.id, body.label);
    if (typeof body.position === "number") {
      const ids = units.map((u) => u.id).filter((id) => id !== unit.id);
      ids.splice(Math.max(0, Math.min(body.position, ids.length)), 0, unit.id);
      setUnitPositions(ctx.db, ids);
    }
    return c.json({ units: getUnitsBySession(ctx.db, sessionId) });
  });

  return router;
}
