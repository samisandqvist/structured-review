import type { Flow } from "./graph/provider.js";

export interface PlanUnitInput {
  kind: "flow" | "orphans";
  flowEntryStableId?: string;
  flowEntryStableIds?: string[];
  orphanStableIds?: string[];
  /** File globs resolved to orphan stableIds at plan submit (globs.ts). */
  orphanFiles?: string[];
  label: string;
  rationale?: string;
}

/** Normalized, deduped entry list for a flow-unit ([] for orphan-units).
 *  Accepts the legacy singular field, the plural one, or both. */
export function flowEntries(unit: PlanUnitInput): string[] {
  if (unit.kind !== "flow") return [];
  const list = [
    ...(unit.flowEntryStableIds ?? []),
    ...(unit.flowEntryStableId ? [unit.flowEntryStableId] : []),
  ];
  return [...new Set(list)];
}

/** The changed stableIds a single unit covers. A flow-unit covers the union of
 *  changed steps across the flows whose entries (depth-0 steps) match its entry
 *  list; an orphan-unit covers its listed members that are actually changed. */
export function unitCoverage(unit: PlanUnitInput, flows: Flow[], changed: Set<string>): string[] {
  if (unit.kind === "flow") {
    const covered = new Set<string>();
    for (const entry of flowEntries(unit)) {
      const flow = flows.find((f) => f.steps[0]?.stableId === entry);
      for (const s of flow?.steps ?? []) if (changed.has(s.stableId)) covered.add(s.stableId);
    }
    return [...covered];
  }
  return (unit.orphanStableIds ?? []).filter((id) => changed.has(id));
}

export function computeCoverage(
  units: PlanUnitInput[],
  flows: Flow[],
  changedStableIds: string[]
): { covered: string[]; unassigned: string[] } {
  const changed = new Set(changedStableIds);
  const covered = new Set<string>();
  for (const u of units) for (const id of unitCoverage(u, flows, changed)) covered.add(id);
  const unassigned = changedStableIds.filter((id) => !covered.has(id));
  return { covered: [...covered], unassigned };
}
