import { useState } from "react";
import { useFlows, useNodes, useSession, useUpdateNodeStatus } from "../api/hooks.js";
import { useUIStore } from "../store/ui.js";
import type { Flow, FlowStep, Node, Unit } from "../api/client.js";

export function PlanView({
  sessionId, currentNodeId, onSelectNode,
}: {
  sessionId: string;
  currentNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  const { data: sessionData } = useSession(sessionId);
  const { data: flowsData } = useFlows(sessionId);
  const { data: nodesData } = useNodes(sessionId);

  const units = (sessionData?.units ?? []).slice().sort((a, b) => a.position - b.position);
  const flowByEntry = new Map((flowsData?.flows ?? []).map((f) => [f.entryStableId, f]));
  const nodeByStable = new Map((nodesData?.nodes ?? []).map((n) => [n.stableId, n]));

  if (units.length === 0) {
    return (
      <div style={empty}>
        <div style={{ maxWidth: 320, textAlign: "center" }}>
          <div style={{ fontSize: 26, marginBottom: 10, opacity: 0.5 }}>⌖</div>
          <h2 style={{ fontSize: 16, marginBottom: 6 }}>No review plan yet</h2>
          <p style={{ color: "var(--dim)", fontSize: 13, lineHeight: 1.6, margin: 0 }}>
            Run the walkthrough skill to build a plan, or check that the session has changes.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={wrap}>
      <div style={head}>
        <span style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 15 }}>Plan</span>
        <span style={{ color: "var(--dim)", fontSize: 13 }}>{units.length} units</span>
      </div>
      <div style={{ overflow: "auto", flex: 1, padding: "4px 16px 20px" }}>
        {units.map((u) => (
          <UnitBlock
            key={u.id}
            sessionId={sessionId}
            unit={u}
            flows={u.kind === "flow"
              ? u.memberStableIds.map((id) => flowByEntry.get(id)).filter((f): f is Flow => !!f)
              : []}
            nodeByStable={nodeByStable}
            currentNodeId={currentNodeId}
            onSelectNode={onSelectNode}
          />
        ))}
      </div>
    </div>
  );
}

function UnitBlock({
  sessionId, unit, flows, nodeByStable, currentNodeId, onSelectNode,
}: {
  sessionId: string;
  unit: Unit;
  flows: Flow[];
  nodeByStable: Map<string, Node>;
  currentNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  const memberNodes = unit.memberStableIds.map((s) => nodeByStable.get(s)).filter((n): n is Node => !!n);

  // For a flow-unit with resolved flows, progress is over the distinct changed
  // steps across all its tracks (a shared node counts once). For orphan-units
  // (or flow-units with no resolved flow), progress is over memberNodes.
  const changedByStable = new Map<string, FlowStep>();
  for (const f of flows) {
    for (const s of f.steps) {
      if (s.changeStatus === "changed" && !changedByStable.has(s.stableId)) changedByStable.set(s.stableId, s);
    }
  }
  const useFlowProgress = unit.kind === "flow" && flows.length > 0;
  const total = useFlowProgress ? changedByStable.size : memberNodes.length;
  const reviewed = useFlowProgress
    ? [...changedByStable.values()].filter((s) => s.reviewStatus && s.reviewStatus !== "unreviewed").length
    : memberNodes.filter((n) => n.reviewStatus !== "unreviewed").length;

  // Collapse: manual toggle wins; a fully reviewed unit auto-collapses until
  // deliberately re-expanded.
  const collapsedSet = useUIStore((s) => s.collapsedUnits);
  const expandedSet = useUIStore((s) => s.expandedUnits);
  const toggle = useUIStore((s) => s.toggleUnitCollapsed);
  const allReviewed = total > 0 && reviewed === total;
  const collapsed = collapsedSet.includes(unit.id) || (allReviewed && !expandedSet.includes(unit.id));

  const updateStatus = useUpdateNodeStatus(sessionId);
  // Unreviewed changed nodeIds of this unit: flow-units from their tracks'
  // steps, orphan-units (or unresolved flows) from memberNodes.
  const remaining: string[] = useFlowProgress
    ? [...changedByStable.values()]
        .filter((s) => s.nodeId && (!s.reviewStatus || s.reviewStatus === "unreviewed"))
        .map((s) => s.nodeId as string)
    : memberNodes.filter((n) => n.reviewStatus === "unreviewed").map((n) => n.id);
  const markRemaining = () => {
    if (!window.confirm(`Mark ${remaining.length} node${remaining.length === 1 ? "" : "s"} reviewed?`)) return;
    for (const nodeId of remaining) updateStatus.mutate({ nodeId, reviewStatus: "reviewed-clean" });
  };

  return (
    <div className={`unit${unit.auto ? " unit--auto" : ""}`}>
      <div className="unit__bar">
        <button
          data-testid="unit-collapse"
          className="unit__chevron"
          aria-label={collapsed ? "expand unit" : "collapse unit"}
          onClick={() => toggle(unit.id, collapsed)}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <h3 className="unit__name">{unit.label}</h3>
        {unit.auto && <span className="unit__badge">unassigned</span>}
        {remaining.length > 0 && (
          <button
            data-testid="mark-remaining"
            className="unit__bulk"
            title="Mark remaining reviewed"
            onClick={markRemaining}
          >
            ✓✓
          </button>
        )}
        {total > 0 && (
          <span className="unit__progress">{reviewed}/{total}</span>
        )}
      </div>
      {!collapsed && unit.rationale && <p className="unit__rationale">{unit.rationale}</p>}

      {collapsed ? null : unit.kind === "flow" && flows.length > 0 ? (
        flows.map((f) => (
          <div key={f.entryStableId}>
            {flows.length > 1 && <div className="unit__track-caption">{f.name}</div>}
            <FlowTrack flow={f} currentNodeId={currentNodeId} onSelectNode={onSelectNode} />
          </div>
        ))
      ) : (
        <div className="unit__chips">
          {memberNodes.map((n) => (
            <StepChip
              key={n.id}
              step={{
                stableId: n.stableId,
                label: n.label, file: n.file, startLine: n.startLine, endLine: n.endLine,
                isTest: n.isTest, depth: 0, nodeId: n.id, changeStatus: n.changeStatus, reviewStatus: n.reviewStatus,
              }}
              current={n.id === currentNodeId}
              onSelect={onSelectNode}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type TrackRow =
  | { kind: "step"; step: FlowStep; index: number }
  | { kind: "run"; steps: FlowStep[]; index: number };

/** Group consecutive off-path context steps into one collapsible run. */
function trackRows(steps: FlowStep[]): TrackRow[] {
  const rows: TrackRow[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s.offPath) {
      rows.push({ kind: "step", step: s, index: i });
      continue;
    }
    const run: FlowStep[] = [s];
    while (i + 1 < steps.length && steps[i + 1].offPath) run.push(steps[++i]);
    rows.push({ kind: "run", steps: run, index: i - run.length + 1 });
  }
  return rows;
}

function FlowTrack({
  flow, currentNodeId, onSelectNode,
}: {
  flow: Flow;
  currentNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const renderStep = (s: FlowStep, key: string) => (
    <div key={key} className="flow__row" style={{ paddingLeft: s.depth * 22 }}>
      {s.depth > 0 && <span className="flow__branch">└</span>}
      <StepChip step={s} current={!!s.nodeId && s.nodeId === currentNodeId} onSelect={onSelectNode} />
    </div>
  );

  return (
    <div className="flow__tree">
      {trackRows(flow.steps).map((row) => {
        if (row.kind === "step") return renderStep(row.step, `s-${row.index}`);
        if (expanded.has(row.index)) return row.steps.map((s, j) => renderStep(s, `s-${row.index}-${j}`));
        return (
          <div key={`run-${row.index}`} className="flow__row" style={{ paddingLeft: row.steps[0].depth * 22 }}>
            <button
              className="flow__collapsed"
              onClick={() => setExpanded((e) => new Set(e).add(row.index))}
            >
              ⋯ {row.steps.length} unchanged call{row.steps.length === 1 ? "" : "s"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function StepChip({
  step, current, onSelect,
}: {
  step: FlowStep;
  current: boolean;
  onSelect: (nodeId: string) => void;
}) {
  const cls = [
    "step",
    step.changeStatus === "changed" ? "step--changed" : "",
    step.changeStatus === null ? "step--ext" : "",
    step.isTest ? "step--test" : "",
    step.reviewStatus && step.reviewStatus !== "unreviewed" ? "step--reviewed" : "",
    current ? "step--current" : "",
  ].filter(Boolean).join(" ");
  return (
    <button
      className={cls}
      disabled={!step.nodeId}
      onClick={() => step.nodeId && onSelect(step.nodeId)}
      title={`${step.file}:${step.startLine}`}
    >
      {step.label}
    </button>
  );
}

const wrap: React.CSSProperties = {
  flex: 1, height: "100%", display: "flex", flexDirection: "column",
  background: "var(--panel)", minHeight: 0,
};
const head: React.CSSProperties = {
  display: "flex", alignItems: "baseline", justifyContent: "space-between",
  padding: "14px 16px 10px", borderBottom: "1px solid var(--line)",
};
const empty: React.CSSProperties = {
  flex: 1, height: "100%", display: "grid", placeItems: "center", background: "var(--panel)",
};
