// Plan-time attachment derivation: nest unassigned changed nodes (tests, DTOs,
// module-scope residuals) under the covered node that gives them context.
// Runs inside PUT /plan; results persist on units and die with them (spec:
// docs/review-model.md#attachments).
import { flowEntries, unitCoverage, type PlanUnitInput } from "./coverage.js";
import type { FileRequires, Flow } from "./graph/provider.js";
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
    const parent = m.residualKind ? members.find((o) => !o.residualKind && o.file === m.file) : undefined;
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
  byStable: Map<string, AttachNode>,
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

interface AttachmentContext {
  byStable: Map<string, AttachNode>;
  covered: Set<string>;
  walk: Map<string, WalkPos>;
  byWalk: (a: string, b: string) => number;
  testsByTest: Map<string, string[]>;
  fileRequires: FileRequires;
}

function indexTestEdges(edges: TestEdge[]): Map<string, string[]> {
  const byTest = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = byTest.get(edge.testStableId) ?? [];
    targets.push(edge.productionStableId);
    byTest.set(edge.testStableId, targets);
  }
  return byTest;
}

/** First exercised covered node owns the test; other units get one reference each. */
function exercisedAttachments(node: AttachNode, context: AttachmentContext): AttachedMember[] | null {
  if (!node.isTest) return null;
  const { covered, testsByTest, byWalk, walk } = context;
  const exercised = [...new Set(testsByTest.get(node.stableId) ?? [])].filter((id) => covered.has(id)).sort(byWalk);
  if (exercised.length === 0) return null;
  const parent = exercised[0];
  if (!parent) return [];
  const members: AttachedMember[] = [
    { stableId: node.stableId, parentStableId: parent, reason: "tested-by", counted: true },
  ];
  const refUnits = new Set([walk.get(parent)!.unitIndex]);
  for (const other of exercised.slice(1)) {
    const unitIndex = walk.get(other)!.unitIndex;
    if (refUnits.has(unitIndex)) continue;
    refUnits.add(unitIndex);
    members.push({ stableId: node.stableId, parentStableId: other, reason: "tested-by", counted: false });
  }
  return members;
}

/** Match the first covered node of this file, including module-scope residuals. */
function sameFileAttachments(node: AttachNode, context: AttachmentContext): AttachedMember[] | null {
  const parents = [...context.covered]
    .filter((id) => context.byStable.get(id)?.file === node.file)
    .sort(context.byWalk);
  if (parents.length === 0) return null;
  const parentStableId = parents[0];
  return parentStableId ? [{ stableId: node.stableId, parentStableId, reason: "same-file", counted: true }] : [];
}

/** A changed definition belongs under the first covered consumer of its file. */
function consumerAttachments(node: AttachNode, context: AttachmentContext): AttachedMember[] | null {
  const parents = [...context.covered]
    .filter((id) => context.fileRequires.get(context.byStable.get(id)?.file ?? "")?.has(node.file))
    .sort(context.byWalk);
  if (parents.length === 0) return null;
  const parentStableId = parents[0];
  return parentStableId ? [{ stableId: node.stableId, parentStableId, reason: "required-by", counted: true }] : [];
}

/** Test imports are fallback evidence only: basename matches beat walk order,
 * and type-only references qualify only with a matching subject name (#11/#12). */
function importedTestAttachments(node: AttachNode, context: AttachmentContext): AttachedMember[] {
  if (!node.isTest) return [];
  const { byStable, covered, fileRequires, byWalk } = context;
  const stems = testNameStems(node.file);
  const nameMatch = (id: string) => stems.has(fileStem(byStable.get(id)!.file));
  const rank = (id: string) => (nameMatch(id) ? 0 : 1);
  const reqs = fileRequires.get(node.file);
  const imported = [...covered]
    .filter((id) => {
      const edge = reqs?.get(byStable.get(id)?.file ?? "");
      return edge != null && (edge.hasValueRef || nameMatch(id));
    })
    .sort((a, b) => rank(a) - rank(b) || byWalk(a, b));
  const parentStableId = imported[0];
  return parentStableId ? [{ stableId: node.stableId, parentStableId, reason: "tested-by", counted: true }] : [];
}

function appendAttachments(attached: AttachedMember[][], members: AttachedMember[], walk: Map<string, WalkPos>) {
  for (const member of members) {
    const position = walk.get(member.parentStableId);
    if (!position) throw new Error(`attachment parent '${member.parentStableId}' is outside the review walk`);
    const unitMembers = attached[position.unitIndex];
    if (!unitMembers) throw new Error(`review walk references missing unit ${position.unitIndex}`);
    unitMembers.push(member);
  }
}

/** Four ordered rules, first match wins. Only explicitly covered nodes can be
 * parents (no attachment chaining); explicitly planned nodes are never candidates. */
export function deriveAttachments(
  units: PlanUnitInput[],
  flows: Flow[],
  nodes: AttachNode[],
  testEdges: TestEdge[],
  fileRequires: FileRequires,
): AttachedMember[][] {
  const byStable = new Map(nodes.map((n) => [n.stableId, n]));
  const changed = new Set(nodes.filter((n) => n.changeStatus === "changed").map((n) => n.stableId));
  const covered = new Set(units.flatMap((u) => unitCoverage(u, flows, changed)));
  const walk = walkPositions(units, flows, changed, byStable);
  const context: AttachmentContext = {
    byStable,
    covered,
    walk,
    fileRequires,
    byWalk: (a, b) => walk.get(a)!.pos - walk.get(b)!.pos,
    testsByTest: indexTestEdges(testEdges),
  };
  const attached: AttachedMember[][] = units.map(() => []);
  const unassigned = [...changed].filter((id) => !covered.has(id)).sort();
  for (const stableId of unassigned) {
    const node = byStable.get(stableId)!;
    const members =
      exercisedAttachments(node, context) ??
      sameFileAttachments(node, context) ??
      consumerAttachments(node, context) ??
      importedTestAttachments(node, context);
    appendAttachments(attached, members, walk);
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
  return new Set(
    attached
      .flat()
      .filter((m) => m.counted)
      .map((m) => m.stableId),
  );
}
