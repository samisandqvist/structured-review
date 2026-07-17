// packages/skill/src/status.ts — pure per-unit progress computation.
// Mirrors the web PlanView: a flow-unit with resolved flows counts the distinct
// changed nodes across its flows' steps; orphan-units (and flow-units whose
// flows didn't resolve) count their changed member nodes directly.
import type { Coverage, FlowDTO, SessionInfo, SessionNode, Unit } from "./api.js";

export interface UnitStatus { label: string; kind: "flow" | "orphans"; auto: boolean; reviewed: number; total: number; }
export interface UnreviewedNode { stableId: string; label: string; file: string; }
export interface SessionStatus {
  sessionId: string;
  sessionStatus: string;
  coverage: Coverage;
  stale?: boolean;
  staleReason?: string;
  units: UnitStatus[];
  unreviewed: UnreviewedNode[];
}

function unitProgress(unit: Unit, flows: FlowDTO[], byStable: Map<string, SessionNode>): { reviewed: number; total: number } {
  if (unit.kind === "flow") {
    const entries = new Set(unit.memberStableIds);
    const unitFlows = flows.filter((f) => entries.has(f.entryStableId));
    if (unitFlows.length > 0) {
      const changed = new Set<string>();
      for (const f of unitFlows) {
        for (const s of f.steps) {
          if (byStable.get(s.stableId)?.changeStatus === "changed") changed.add(s.stableId);
        }
      }
      const reviewed = [...changed].filter((id) => byStable.get(id)!.reviewStatus !== "unreviewed").length;
      return { reviewed, total: changed.size };
    }
  }
  const members = unit.memberStableIds
    .map((id) => byStable.get(id))
    .filter((n): n is SessionNode => !!n && n.changeStatus === "changed");
  return { reviewed: members.filter((n) => n.reviewStatus !== "unreviewed").length, total: members.length };
}

export function computeStatus(info: SessionInfo, nodes: SessionNode[], flows: FlowDTO[]): SessionStatus {
  const byStable = new Map(nodes.map((n) => [n.stableId, n]));
  const units = info.units.map((u) => ({
    label: u.label, kind: u.kind, auto: u.auto,
    ...unitProgress(u, flows, byStable),
  }));
  const unreviewed = nodes
    .filter((n) => n.changeStatus === "changed" && n.reviewStatus === "unreviewed")
    .map((n) => ({ stableId: n.stableId, label: n.label, file: n.file }));
  return {
    sessionId: info.session.id,
    sessionStatus: info.session.status,
    coverage: info.coverage,
    ...(info.stale === undefined ? {} : { stale: info.stale }),
    ...(info.staleReason ? { staleReason: info.staleReason } : {}),
    units,
    unreviewed,
  };
}

/** Wait-condition predicates for `crw wait`. */
export function waitConditionMet(
  until: "reviewed" | "commented",
  status: SessionStatus,
  commentCount: number
): boolean {
  if (until === "commented") return commentCount > 0;
  return status.unreviewed.length === 0;
}
