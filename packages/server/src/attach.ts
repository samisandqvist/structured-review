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
  residualKind?: string | null;
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

/** Orphan-unit member order (mirrors web orphan-layout.ts): a residual member
 *  walks right after the first non-residual member of its file; the rest keep
 *  listed order grouped by directory (order of first appearance). */
export function orphanWalkIds(memberIds: string[], byStable: Map<string, AttachNode>): string[] {
  const members = memberIds.map((id) => byStable.get(id)).filter((n): n is AttachNode => !!n);
  const dirOf = (file: string) => file.slice(0, Math.max(0, file.lastIndexOf("/")));
  const nestedByParent = new Map<string, string[]>();
  const topLevel: AttachNode[] = [];
  for (const m of members) {
    const parent = m.residualKind
      ? members.find((o) => !o.residualKind && o.file === m.file)
      : undefined;
    if (parent) {
      const list = nestedByParent.get(parent.stableId) ?? [];
      list.push(m.stableId);
      nestedByParent.set(parent.stableId, list);
    } else {
      topLevel.push(m);
    }
  }
  const byDir = new Map<string, string[]>();
  for (const n of topLevel) {
    const dir = dirOf(n.file);
    const list = byDir.get(dir) ?? [];
    list.push(n.stableId, ...(nestedByParent.get(n.stableId) ?? []));
    byDir.set(dir, list);
  }
  const out = [...byDir.values()].flat();
  for (const id of memberIds) if (!byStable.has(id)) out.push(id);
  return out;
}

/** Covered changed nodes in canonical walk order (mirrors web buildWalkOrder:
 *  units in given order; flow steps in tree order; orphan members in layout
 *  order — see orphanWalkIds; changed only; first occurrence wins). */
function walkPositions(
  units: PlanUnitInput[],
  flows: Flow[],
  changed: Set<string>,
  byStable: Map<string, AttachNode>
): Map<string, WalkPos> {
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
      for (const stableId of orphanWalkIds(u.orphanStableIds ?? [], byStable)) push(stableId);
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
  const walk = walkPositions(units, flows, changed, byStable);
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
      continue;
    }

    // Pass 4 — test imports: a test whose call edges didn't resolve (e.g.
    // vitest `it()` bodies are anonymous callbacks, so no TESTED_BY edge
    // forms) still names what it exercises via its file's imports. Nest it
    // under the covered node its file requires, ranked by evidence strength:
    // a basename match (users.service.spec -> users.service) beats walk
    // order — otherwise an early unit holding a widely-imported hub file
    // (schema, shared types) becomes a magnet for every changed test (#11).
    // Tests only — for production code this reversed direction would attach
    // on far weaker evidence.
    if (node.isTest) {
      const stems = testNameStems(node.file);
      const rank = (id: string) => (stems.has(fileStem(byStable.get(id)!.file)) ? 0 : 1);
      const imported = [...covered]
        .filter((c) => fileRequires.get(node.file)?.has(byStable.get(c)?.file ?? ""))
        .sort((a, b) => rank(a) - rank(b) || byWalk(a, b));
      if (imported.length > 0) {
        attach({ stableId, parentStableId: imported[0], reason: "tested-by", counted: true });
      }
    }
  }
  return attached;
}

/** Lowercased basename without extension: src/a/Users.service.ts -> users.service. */
function fileStem(file: string): string {
  const base = file.slice(file.lastIndexOf("/") + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** The subject stems a test file's name points at, lowercased: its own stem
 *  plus that stem with one common test marker stripped — separator suffix
 *  (users.service.spec -> users.service), bare suffix (UsersServiceTest ->
 *  UsersService), or prefix (test_users -> users). */
function testNameStems(file: string): Set<string> {
  const stem = fileStem(file);
  const out = new Set([stem]);
  const sep = /[._-](spec|specs|test|tests)$/.exec(stem);
  if (sep) out.add(stem.slice(0, sep.index));
  const bare = /(spec|test|tests)$/.exec(stem);
  if (bare && bare.index > 0) out.add(stem.slice(0, bare.index));
  const prefix = /^(test|spec)[._-]/.exec(stem);
  if (prefix) out.add(stem.slice(prefix[0].length));
  return out;
}

/** Counted attachment stableIds across all units (they count as covered). */
export function countedAttachmentIds(attached: AttachedMember[][]): Set<string> {
  return new Set(attached.flat().filter((m) => m.counted).map((m) => m.stableId));
}
