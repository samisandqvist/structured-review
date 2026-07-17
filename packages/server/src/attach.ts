// Plan-time attachment derivation: nest unassigned changed nodes (tests, DTOs,
// module-scope residuals) under the covered node that gives them context.
// Runs inside PUT /plan; results persist on units and die with them (spec:
// docs/superpowers/specs/2026-07-17-unassigned-changes-design.md).
import { flowEntries, unitCoverage, type PlanUnitInput } from "./coverage.js";
import type { Flow } from "./graph/provider.js";
import type { AttachedMember } from "./types.js";

/** The node facts derivation needs — a subset of the session Node. */
export interface AttachNode {
  stableId: string;
  file: string;
  isTest: boolean;
  changeStatus: string;
}

/** One session TESTED_BY edge, by stableId (production tested-by test). */
export interface TestEdge {
  productionStableId: string;
  testStableId: string;
}

interface WalkPos {
  unitIndex: number;
  pos: number;
}

/** Covered changed nodes in canonical walk order (mirrors web buildWalkOrder:
 *  units in given order; flow steps in tree order; orphan members in listed
 *  order; changed only; first occurrence wins). */
function walkPositions(units: PlanUnitInput[], flows: Flow[], changed: Set<string>): Map<string, WalkPos> {
  const flowByEntry = new Map(flows.map((f) => [f.steps[0]?.stableId ?? "", f]));
  const walk = new Map<string, WalkPos>();
  let pos = 0;
  units.forEach((u, unitIndex) => {
    const push = (stableId: string) => {
      if (!changed.has(stableId) || walk.has(stableId)) return;
      walk.set(stableId, { unitIndex, pos: pos++ });
    };
    if (u.kind === "flow") {
      for (const entry of flowEntries(u)) {
        for (const s of flowByEntry.get(entry)?.steps ?? []) push(s.stableId);
      }
    } else {
      for (const stableId of u.orphanStableIds ?? []) push(stableId);
    }
  });
  return walk;
}

/**
 * Three passes over the plan's unassigned changed nodes, first match wins.
 * Parents are always plan-covered nodes (no chaining); explicit plan
 * membership wins because covered nodes are never candidates here.
 * Returns per-unit attachment lists, indexed like `units`.
 */
export function deriveAttachments(
  units: PlanUnitInput[],
  flows: Flow[],
  nodes: AttachNode[],
  testEdges: TestEdge[],
  fileRequires: Map<string, Set<string>>
): AttachedMember[][] {
  const byStable = new Map(nodes.map((n) => [n.stableId, n]));
  const changed = new Set(nodes.filter((n) => n.changeStatus === "changed").map((n) => n.stableId));
  const covered = new Set(units.flatMap((u) => unitCoverage(u, flows, changed)));
  const walk = walkPositions(units, flows, changed);
  const byWalk = (a: string, b: string) => walk.get(a)!.pos - walk.get(b)!.pos;

  const testsByTest = new Map<string, string[]>();
  for (const e of testEdges) {
    (testsByTest.get(e.testStableId) ?? testsByTest.set(e.testStableId, []).get(e.testStableId)!).push(e.productionStableId);
  }

  const attached: AttachedMember[][] = units.map(() => []);
  const attach = (m: AttachedMember) => attached[walk.get(m.parentStableId)!.unitIndex].push(m);

  const unassigned = [...changed].filter((id) => !covered.has(id)).sort();
  for (const stableId of unassigned) {
    const node = byStable.get(stableId)!;

    // Pass 1 — tested-by: nest under the first exercised covered node; other
    // exercised nodes in *other* units get render-only references.
    if (node.isTest) {
      const exercised = [...new Set(testsByTest.get(stableId) ?? [])].filter((p) => covered.has(p)).sort(byWalk);
      if (exercised.length > 0) {
        const parent = exercised[0];
        attach({ stableId, parentStableId: parent, reason: "tested-by", counted: true });
        const refUnits = new Set<number>();
        for (const other of exercised.slice(1)) {
          const unitIndex = walk.get(other)!.unitIndex;
          if (unitIndex === walk.get(parent)!.unitIndex || refUnits.has(unitIndex)) continue;
          refUnits.add(unitIndex);
          attach({ stableId, parentStableId: other, reason: "tested-by", counted: false });
        }
        continue;
      }
    }

    // Pass 2 — same-file: module-scope residuals (and friends) nest under the
    // first covered node of their own file.
    const sameFile = [...covered].filter((c) => byStable.get(c)?.file === node.file).sort(byWalk);
    if (sameFile.length > 0) {
      attach({ stableId, parentStableId: sameFile[0], reason: "same-file", counted: true });
      continue;
    }

    // Pass 3 — required-by: nest under the first covered node whose file
    // requires this node's file (DTO -> consumer).
    const consumers = [...covered]
      .filter((c) => fileRequires.get(byStable.get(c)?.file ?? "")?.has(node.file))
      .sort(byWalk);
    if (consumers.length > 0) {
      attach({ stableId, parentStableId: consumers[0], reason: "required-by", counted: true });
    }
  }
  return attached;
}

/** Counted attachment stableIds across all units (they count as covered). */
export function countedAttachmentIds(attached: AttachedMember[][]): Set<string> {
  return new Set(attached.flat().filter((m) => m.counted).map((m) => m.stableId));
}
