import type { Node } from "./api/client.js";

/** Presentation structure for orphan-unit members, which have no call-graph
 *  relationships to order them:
 *  1. a file residual nests under the first function node of its own file in
 *     the unit (same as flow units nest residual attachments), and
 *  2. remaining members group by directory — unless they all share one
 *     directory, which renders flat (dir: null).
 *  The walk order flattens this same structure, so what you see is the order
 *  you walk (web walk-order.ts and server attach.ts both consume it). */
export interface OrphanEntry {
  node: Node;
  nested: Node[];
}
export interface OrphanGroup {
  /** null = single-directory unit, render without a header. "." = repo root. */
  dir: string | null;
  entries: OrphanEntry[];
}

function dirOf(file: string): string {
  const i = file.lastIndexOf("/");
  return i === -1 ? "" : file.slice(0, i);
}

export function buildOrphanLayout(
  memberStableIds: string[],
  nodeByStable: Map<string, Node>
): OrphanGroup[] {
  const members = memberStableIds
    .map((id) => nodeByStable.get(id))
    .filter((n): n is Node => !!n);

  const nestedByParent = new Map<string, Node[]>();
  const topLevel: Node[] = [];
  for (const m of members) {
    const parent = m.residualKind
      ? members.find((o) => !o.residualKind && o.file === m.file)
      : undefined;
    if (parent) {
      const list = nestedByParent.get(parent.stableId) ?? [];
      list.push(m);
      nestedByParent.set(parent.stableId, list);
    } else {
      topLevel.push(m);
    }
  }

  const byDir = new Map<string, OrphanEntry[]>();
  for (const n of topLevel) {
    const dir = dirOf(n.file);
    const list = byDir.get(dir) ?? [];
    list.push({ node: n, nested: nestedByParent.get(n.stableId) ?? [] });
    byDir.set(dir, list);
  }
  if (byDir.size <= 1) {
    return [{ dir: null, entries: [...byDir.values()][0] ?? [] }];
  }
  return [...byDir.entries()].map(([dir, entries]) => ({ dir: dir === "" ? "." : dir, entries }));
}

/** The layout flattened to stableIds — the orphan-unit walk order. */
export function orphanWalkIds(memberStableIds: string[], nodeByStable: Map<string, Node>): string[] {
  const known = new Set(
    memberStableIds.filter((id) => nodeByStable.has(id))
  );
  const out: string[] = [];
  for (const g of buildOrphanLayout(memberStableIds, nodeByStable)) {
    for (const e of g.entries) {
      out.push(e.node.stableId);
      for (const r of e.nested) out.push(r.stableId);
    }
  }
  // Members without a session node (shouldn't happen, but never drop coverage):
  for (const id of memberStableIds) {
    if (!known.has(id)) out.push(id);
  }
  return out;
}
