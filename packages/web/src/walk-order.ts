import type { Unit, Flow, Node } from "./api/client.js";
import { orphanWalkIds } from "./orphan-layout.js";

export interface WalkEntry {
  nodeId: string;
  stableId: string;
}

/** Canonical review sequence: units by position; flow steps in tree order;
 *  orphan members in layout order (residuals right after their file's function
 *  node, then directory groups — see orphan-layout.ts); changed nodes only;
 *  first occurrence wins. Counted attachments walk immediately after their
 *  parent node. */
export function buildWalkOrder(units: Unit[], flows: Flow[], nodes: Node[]): WalkEntry[] {
  const flowByEntry = new Map(flows.map((f) => [f.entryStableId, f]));
  const nodeByStable = new Map(nodes.map((n) => [n.stableId, n]));
  const seen = new Set<string>();
  const order: WalkEntry[] = [];
  const push = (stableId: string, nodeId: string | null) => {
    if (!nodeId || seen.has(nodeId)) return;
    seen.add(nodeId);
    order.push({ nodeId, stableId });
  };
  for (const u of [...units].sort((a, b) => a.position - b.position)) {
    const attachedByParent = new Map<string, string[]>();
    for (const m of u.attached ?? []) {
      if (!m.counted) continue;
      const list = attachedByParent.get(m.parentStableId) ?? [];
      list.push(m.stableId);
      attachedByParent.set(m.parentStableId, list);
    }
    const pushWithAttached = (stableId: string, nodeId: string | null) => {
      push(stableId, nodeId);
      for (const a of attachedByParent.get(stableId) ?? []) {
        const an = nodeByStable.get(a);
        if (an && an.changeStatus === "changed") push(a, an.id);
      }
    };
    if (u.kind === "flow") {
      for (const entry of u.memberStableIds) {
        for (const s of flowByEntry.get(entry)?.steps ?? []) {
          if (s.changeStatus === "changed") pushWithAttached(s.stableId, s.nodeId);
        }
      }
    } else {
      for (const stableId of orphanWalkIds(u.memberStableIds, nodeByStable)) {
        const n = nodeByStable.get(stableId);
        if (n && n.changeStatus === "changed") pushWithAttached(stableId, n.id);
      }
    }
  }
  return order;
}

/** Next/previous nodeId in walk order, wrapping; null on an empty order. */
export function nextInWalk(order: WalkEntry[], currentNodeId: string | null, dir: 1 | -1): string | null {
  if (order.length === 0) return null;
  const i = currentNodeId ? order.findIndex((w) => w.nodeId === currentNodeId) : -1;
  if (i === -1) return order[dir === 1 ? 0 : order.length - 1].nodeId;
  return order[(i + dir + order.length) % order.length].nodeId;
}

/** First unreviewed nodeId after the current one (wrapping), or null when done. */
export function nextUnreviewed(order: WalkEntry[], nodes: Node[], currentNodeId: string | null): string | null {
  const statusById = new Map(nodes.map((n) => [n.id, n.reviewStatus]));
  const start = currentNodeId ? order.findIndex((w) => w.nodeId === currentNodeId) : -1;
  for (let k = 1; k <= order.length; k++) {
    const w = order[(start + k) % order.length];
    if (statusById.get(w.nodeId) === "unreviewed") return w.nodeId;
  }
  return null;
}
