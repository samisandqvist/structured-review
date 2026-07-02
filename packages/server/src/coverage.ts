import type { Flow } from "./graph/provider.js";

export interface PlanUnitInput {
  kind: "flow" | "orphans";
  flowEntryStableId?: string;
  orphanStableIds?: string[];
  label: string;
  rationale?: string;
}

/** The changed stableIds a single unit covers. A flow-unit covers the changed
 *  steps of the flow whose entry (depth-0 step) matches flowEntryStableId; an
 *  orphan-unit covers its listed members that are actually changed. */
export function unitCoverage(unit: PlanUnitInput, flows: Flow[], changed: Set<string>): string[] {
  if (unit.kind === "flow") {
    const flow = flows.find((f) => f.steps[0]?.stableId === unit.flowEntryStableId);
    if (!flow) return [];
    return flow.steps.map((s) => s.stableId).filter((id) => changed.has(id));
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
