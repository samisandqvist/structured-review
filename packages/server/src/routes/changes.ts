import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { getSession } from "../repo/sessions.js";
import { getNodesBySession } from "../repo/nodes.js";
import { commitSubjects, fileUnifiedDiff, nodeChangeStats, nodeSignature } from "../diff.js";

/** Compact, software-computed change summary per changed node — no diff bodies.
 *  Bounded by node count, not diff size. */
export function createChangesRoute(ctx: AppContext) {
  const router = new Hono();

  router.get("/:id/changes", (c) => {
    const sessionId = c.req.param("id");
    const session = getSession(ctx.db, sessionId);
    if (!session) return c.json({ error: "not found" }, 404);

    const changed = getNodesBySession(ctx.db, sessionId).filter((n) => n.changeStatus === "changed");
    const rawByFile = new Map<string, string | null>();
    const rawFor = (file: string) => {
      if (!rawByFile.has(file)) rawByFile.set(file, fileUnifiedDiff(session.baseRef, file, ctx.repoRoot));
      return rawByFile.get(file) ?? null;
    };

    const changes = changed.map((n) => {
      const raw = rawFor(n.file);
      const { added, removed } = raw ? nodeChangeStats(raw, n.startLine, n.endLine) : { added: 0, removed: 0 };
      const span = n.endLine - n.startLine + 1;
      const status = removed === 0 && added >= span ? "added" : "modified";
      // Heuristic: SCIP sets no symbol kind. Residual pseudo-nodes are tagged by their
      // stableId scheme; beyond that only functions/methods reach this point (types/
      // namespaces are filtered upstream when building graph nodes).
      const kind = n.stableId.startsWith("file-residual:")
        ? "file"
        : n.isTest
          ? "test"
          : n.stableId.includes("#")
            ? "method"
            : "function";
      return {
        stableId: n.stableId,
        label: n.label,
        kind,
        file: n.file,
        startLine: n.startLine,
        endLine: n.endLine,
        status,
        added,
        removed,
        signature: nodeSignature(n.file, n.startLine, ctx.repoRoot),
      };
    });
    // Subjects of the session's commit range ride along as intent input for
    // plan authoring — the planner should not need its own git log.
    return c.json({ changes, commitSubjects: commitSubjects(session.baseRef, ctx.repoRoot) });
  });

  return router;
}
