// Orphan-unit file globs (plan submit): a plan can claim orphans by path
// pattern instead of hand-listing stableIds. Deliberately tiny — `**`, `*`,
// `?` over repo-relative posix paths — not a general glob engine.
import type { PlanUnitInput } from "./coverage.js";

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
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
    const regexps = u.orphanFiles.map(globToRegExp);
    const matched = orphanNodes
      .filter((o) => !claimed.has(o.stableId) && regexps.some((r) => r.test(o.file)))
      .map((o) => o.stableId);
    for (const id of matched) claimed.add(id);
    const orphanStableIds = [...(u.orphanStableIds ?? []), ...matched];
    if (orphanStableIds.length === 0) emptyUnits.push(u.label);
    return { ...u, orphanStableIds };
  });
  return { units: resolved, emptyUnits };
}
