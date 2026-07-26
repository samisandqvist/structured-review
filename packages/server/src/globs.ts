// Orphan-unit file globs (plan submit): a plan can claim orphans by path
// pattern instead of hand-listing stableIds. Matching is delegated to
// node:path matchesGlob (stdlib, no package dependency); the test file pins
// the semantics we document — `**`, `*`, `?` over repo-relative posix paths —
// so an upstream behavior change in the still-experimental API fails loudly.
import { posix } from "node:path";
import type { PlanUnitInput } from "./coverage.js";

export function matchGlob(path: string, glob: string): boolean {
  return posix.matchesGlob(path, glob);
}

/**
 * Expand orphan-units' `orphanFiles` globs into stableIds against the
 * session's orphan set (changed nodes in no flow). Explicit ids anywhere are
 * claimed first; glob matches then fill units in plan order (first unit
 * wins), so overlapping globs never double-assign. Returns the labels of
 * units that ended up with zero members so the route can 400 loudly instead
 * of writing a hollow unit.
 */
export function resolveOrphanFiles(
  units: PlanUnitInput[],
  orphanNodes: { stableId: string; file: string }[]
): { units: PlanUnitInput[]; emptyUnits: string[] } {
  const claimed = new Set<string>(
    units.flatMap((u) => (u.kind === "orphans" ? u.orphanStableIds ?? [] : []))
  );
  const emptyUnits: string[] = [];
  const resolved = units.map((u) => {
    if (u.kind !== "orphans" || !u.orphanFiles?.length) return u;
    const matched = orphanNodes
      .filter((o) => !claimed.has(o.stableId) && u.orphanFiles!.some((g) => matchGlob(o.file, g)))
      .map((o) => o.stableId);
    for (const id of matched) claimed.add(id);
    const orphanStableIds = [...(u.orphanStableIds ?? []), ...matched];
    if (orphanStableIds.length === 0) emptyUnits.push(u.label);
    return { ...u, orphanStableIds };
  });
  return { units: resolved, emptyUnits };
}
