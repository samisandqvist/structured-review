import { useState } from "react";
import { useBulkUpdateNodeStatus, useFlows, useNodes, useSession, useUpdateUnit } from "../api/hooks.js";
import { useUIStore } from "../store/ui.js";
import { RESIDUAL_KIND } from "../residual-kind.js";
import { buildOrphanLayout } from "../orphan-layout.js";
import { SessionNotes } from "./SessionNotes.js";
import type { AttachedMember, Flow, FlowStep, GraphEdgeDTO, Node, Unit } from "../api/client.js";

export function PlanView({
  sessionId,
  currentNodeId,
  onSelectNode,
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
  const nodeById = new Map((nodesData?.nodes ?? []).map((n) => [n.id, n]));
  const edges = nodesData?.edges ?? [];

  if (units.length === 0) {
    return (
      <div style={empty}>
        {(sessionData?.session?.indexWarnings?.length ?? 0) > 0 && (
          <div style={warnBanner}>
            {sessionData!.session.indexWarnings!.map((w, i) => (
              <div key={i}>⚠ {w}</div>
            ))}
          </div>
        )}
        <div style={{ maxWidth: 320, textAlign: "center" }}>
          <div style={{ fontSize: 26, marginBottom: 10, opacity: 0.5 }}>⌖</div>
          <h2 style={{ fontSize: 18, marginBottom: 6 }}>No review plan yet</h2>
          <p style={{ color: "var(--dim)", fontSize: 15, lineHeight: 1.6, margin: 0 }}>
            Run the walkthrough skill to build a plan, or check that the session has changes.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={wrap}>
      <div style={head}>
        <h2 style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 17, margin: 0 }}>Plan</h2>
        <span style={{ color: "var(--dim)", fontSize: 15 }}>{units.length} units</span>
      </div>
      {(sessionData?.session?.indexWarnings?.length ?? 0) > 0 && (
        <div style={warnBanner}>
          {sessionData!.session.indexWarnings!.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}
      {sessionData?.session?.overview && <OverviewBlock text={sessionData.session.overview} />}
      <SessionNotes sessionId={sessionId} />
      <div style={{ overflow: "auto", flex: 1, padding: "4px 16px 20px" }}>
        {units.map((u) => (
          <UnitBlock
            key={u.id}
            sessionId={sessionId}
            unit={u}
            flows={
              u.kind === "flow" ? u.memberStableIds.map((id) => flowByEntry.get(id)).filter((f): f is Flow => !!f) : []
            }
            nodeByStable={nodeByStable}
            nodeById={nodeById}
            edges={edges}
            currentNodeId={currentNodeId}
            onSelectNode={onSelectNode}
          />
        ))}
      </div>
    </div>
  );
}

/** Plan-authored narrative: what the change does and how the plan decomposes
 *  it. Marked "from plan" so generated text is never mistaken for tool-derived
 *  fact; collapsible because it is orientation, not workflow. */
function OverviewBlock({ text }: { text: string }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="plan__overview" data-testid="plan-overview">
      <button
        data-testid="plan-overview-toggle"
        className="plan__overview-toggle"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span style={{ fontSize: 11 }}>{collapsed ? "▸" : "▾"}</span> Overview
        <span className="plan__overview-badge">from plan</span>
      </button>
      {!collapsed && <p className="plan__overview-text">{text}</p>}
    </div>
  );
}

/** Tests linked to a unit's production nodes via TESTED_BY edges: how many
 *  exist, how many changed with this diff, and one to jump to. */
function unitTestStats(
  unitNodeIds: Set<string>,
  edges: GraphEdgeDTO[],
  nodeById: Map<string, Node>,
): { total: number; changed: number; firstTestNodeId: string | null } {
  const testIds: string[] = [];
  for (const e of edges) {
    if (e.edgeType === "test" && unitNodeIds.has(e.sourceNodeId) && !testIds.includes(e.targetNodeId)) {
      testIds.push(e.targetNodeId);
    }
  }
  const changed = testIds.filter((id) => nodeById.get(id)?.changeStatus === "changed").length;
  return { total: testIds.length, changed, firstTestNodeId: testIds[0] ?? null };
}

type UnitBlockProps = {
  sessionId: string;
  unit: Unit;
  flows: Flow[];
  nodeByStable: Map<string, Node>;
  nodeById: Map<string, Node>;
  edges: GraphEdgeDTO[];
  currentNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
};

/** Shared flow steps count once, with their first occurrence supplying status. */
function changedFlowSteps(flows: Flow[]): FlowStep[] {
  const changed = new Map<string, FlowStep>();
  for (const flow of flows) {
    for (const step of flow.steps) {
      if (step.changeStatus === "changed" && !changed.has(step.stableId)) changed.set(step.stableId, step);
    }
  }
  return [...changed.values()];
}

function flowReviewProgress(steps: FlowStep[]) {
  return {
    total: steps.length,
    reviewed: steps.filter((step) => step.reviewStatus && step.reviewStatus !== "unreviewed").length,
    remaining: steps
      .filter((step) => step.nodeId && (!step.reviewStatus || step.reviewStatus === "unreviewed"))
      .map((step) => step.nodeId as string),
  };
}

function nodeReviewProgress(nodes: Node[]) {
  return {
    total: nodes.length,
    reviewed: nodes.filter((node) => node.reviewStatus !== "unreviewed").length,
    remaining: nodes.filter((node) => node.reviewStatus === "unreviewed").map((node) => node.id),
  };
}

function groupAttachments(members: AttachedMember[]) {
  const byParent = new Map<string, AttachedMember[]>();
  for (const member of members) {
    const list = byParent.get(member.parentStableId) ?? [];
    list.push(member);
    byParent.set(member.parentStableId, list);
  }
  return byParent;
}

/** Resolved flow units count changed steps; orphan/unresolved units count members.
 * Counted attachments join progress; cross-unit references are render-only. */
function unitReviewState({ unit, flows, nodeByStable, nodeById, edges }: UnitBlockProps) {
  const memberNodes = unit.memberStableIds.map((id) => nodeByStable.get(id)).filter((node): node is Node => !!node);
  const attachments = unit.attached ?? [];
  const attachedNodes = attachments
    .filter((member) => member.counted)
    .map((member) => nodeByStable.get(member.stableId))
    .filter((node): node is Node => !!node && node.changeStatus === "changed");
  const useFlowProgress = unit.kind === "flow" && flows.length > 0;
  const progress = useFlowProgress ? flowReviewProgress(changedFlowSteps(flows)) : nodeReviewProgress(memberNodes);
  const attachedProgress = nodeReviewProgress(attachedNodes);
  // Test linkage includes unchanged production steps too.
  const unitNodeIds = new Set(
    useFlowProgress
      ? flows
          .flatMap((flow) => flow.steps)
          .map((step) => step.nodeId)
          .filter((id): id is string => !!id)
      : memberNodes.map((node) => node.id),
  );
  return {
    total: progress.total + attachedProgress.total,
    reviewed: progress.reviewed + attachedProgress.reviewed,
    remaining: progress.remaining.concat(attachedProgress.remaining),
    attachedByParent: groupAttachments(attachments),
    testStats: unitTestStats(unitNodeIds, edges, nodeById),
  };
}

type UnitProgress = ReturnType<typeof unitReviewState>;

function useUnitActions(sessionId: string, unit: Unit, progress: UnitProgress) {
  const collapsedSet = useUIStore((state) => state.collapsedUnits);
  const expandedSet = useUIStore((state) => state.expandedUnits);
  const toggle = useUIStore((state) => state.toggleUnitCollapsed);
  const allReviewed = progress.total > 0 && progress.reviewed === progress.total;
  const collapsed = collapsedSet.includes(unit.id) || (allReviewed && !expandedSet.includes(unit.id));
  const updateUnit = useUpdateUnit(sessionId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(unit.label);
  const bulkStatus = useBulkUpdateNodeStatus(sessionId);
  const markRemaining = () => {
    const { remaining } = progress;
    if (!window.confirm(`Mark ${remaining.length} node${remaining.length === 1 ? "" : "s"} reviewed?`)) return;
    bulkStatus.mutate({ nodeIds: remaining, reviewStatus: "reviewed-clean" });
  };
  return { collapsed, toggle, updateUnit, editing, setEditing, draft, setDraft, markRemaining };
}

type UnitActions = ReturnType<typeof useUnitActions>;

function UnitBlock(props: UnitBlockProps) {
  const { sessionId, unit, flows, onSelectNode } = props;
  const progress = unitReviewState(props);
  const actions = useUnitActions(sessionId, unit, progress);
  return (
    <div
      className={`unit${unit.auto ? " unit--auto" : ""}`}
      draggable={!unit.auto && !actions.editing}
      onDragStart={(event) => event.dataTransfer.setData("text/unit-id", unit.id)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        const draggedId = event.dataTransfer.getData("text/unit-id");
        if (draggedId && draggedId !== unit.id && !unit.auto) {
          actions.updateUnit.mutate({ unitId: draggedId, position: unit.position });
        }
      }}
    >
      <UnitHeader unit={unit} flows={flows} progress={progress} actions={actions} onSelectNode={onSelectNode} />
      {!actions.collapsed && <UnitContents {...props} attachedByParent={progress.attachedByParent} />}
    </div>
  );
}

function UnitName({ unit, actions }: { unit: Unit; actions: UnitActions }) {
  const { editing, draft } = actions;
  return (
    <>
      {editing && !unit.auto ? (
        <input
          autoFocus
          className="unit__name-input"
          value={draft}
          onChange={(e) => actions.setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              actions.updateUnit.mutate({ unitId: unit.id, label: draft.trim() });
              actions.setEditing(false);
            }
            if (e.key === "Escape") {
              actions.setDraft(unit.label);
              actions.setEditing(false);
            }
          }}
          onBlur={() => actions.setEditing(false)}
        />
      ) : (
        <h3 className="unit__name" onDoubleClick={() => !unit.auto && actions.setEditing(true)}>
          {unit.label}
        </h3>
      )}
    </>
  );
}

function UnitHeader({
  unit,
  flows,
  progress,
  actions,
  onSelectNode,
}: {
  unit: Unit;
  flows: Flow[];
  progress: UnitProgress;
  actions: UnitActions;
  onSelectNode: (nodeId: string) => void;
}) {
  const { total, reviewed, remaining, testStats } = progress;
  const { collapsed, toggle, markRemaining } = actions;
  return (
    <div className="unit__bar">
      <button
        data-testid="unit-collapse"
        className="unit__chevron"
        aria-label={collapsed ? "expand unit" : "collapse unit"}
        onClick={() => toggle(unit.id, collapsed)}
      >
        {collapsed ? "▸" : "▾"}
      </button>
      <UnitName unit={unit} actions={actions} />
      {unit.auto && <span className="unit__badge">unassigned</span>}
      {unit.kind === "flow" && flows.length > 0 && (
        <span
          className="unit__badge"
          data-testid={`entry-conf-${unit.id}`}
          title={`entry evidence: ${flows.map((f) => `${f.name}: ${(f.entryReasons ?? []).join("+")}`).join("; ")}`}
        >
          ⚑ {Math.round(Math.max(...flows.map((f) => f.entryConfidence ?? 0.4)) * 100)}%
        </span>
      )}
      {testStats.total > 0 && (
        <button
          data-testid={`test-chip-${unit.id}`}
          className={`unit__tests${testStats.changed === 0 ? " unit__tests--warn" : ""}`}
          title="Tests linked to this unit (changed/total)"
          onClick={() => testStats.firstTestNodeId && onSelectNode(testStats.firstTestNodeId)}
        >
          tests {testStats.changed}/{testStats.total}
        </button>
      )}
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
        <span className="unit__progress">
          {reviewed}/{total}
        </span>
      )}
    </div>
  );
}

function UnitContents({
  unit,
  flows,
  nodeByStable,
  currentNodeId,
  onSelectNode,
  attachedByParent,
}: UnitBlockProps & { attachedByParent: Map<string, AttachedMember[]> }) {
  return (
    <>
      {unit.rationale && <p className="unit__rationale">{unit.rationale}</p>}

      {unit.kind === "flow" && flows.length > 0 ? (
        flows.map((f) => (
          <div key={f.entryStableId}>
            {flows.length > 1 && <div className="unit__track-caption">{f.name}</div>}
            <FlowTrack
              flow={f}
              attachedByParent={attachedByParent}
              nodeByStable={nodeByStable}
              currentNodeId={currentNodeId}
              onSelectNode={onSelectNode}
            />
          </div>
        ))
      ) : (
        <OrphanTree
          unit={unit}
          attachedByParent={attachedByParent}
          nodeByStable={nodeByStable}
          currentNodeId={currentNodeId}
          onSelectNode={onSelectNode}
        />
      )}
    </>
  );
}

/** Orphan-unit members structured like flow tracks: directory groups when the
 *  unit spans several directories, residual members nested under their file's
 *  function node. Layout comes from buildOrphanLayout; the walk order flattens
 *  the same structure (walk-order.ts). */
function OrphanTree({
  unit,
  attachedByParent,
  nodeByStable,
  currentNodeId,
  onSelectNode,
}: {
  unit: Unit;
  attachedByParent: Map<string, AttachedMember[]>;
  nodeByStable: Map<string, Node>;
  currentNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  const stepOf = (n: Node): FlowStep => ({
    stableId: n.stableId,
    label: n.label,
    file: n.file,
    startLine: n.startLine,
    endLine: n.endLine,
    isTest: n.isTest,
    depth: 0,
    nodeId: n.id,
    changeStatus: n.changeStatus,
    reviewStatus: n.reviewStatus,
    ...(n.residualKind === undefined ? {} : { residualKind: n.residualKind }),
  });
  const renderNode = (n: Node, depth: number) => (
    <div key={n.id}>
      <div className="flow__row" style={{ paddingLeft: depth * 22 }}>
        {depth > 0 && <span className="flow__branch">└</span>}
        <StepChip step={stepOf(n)} current={n.id === currentNodeId} onSelect={onSelectNode} />
      </div>
      {(attachedByParent.get(n.stableId) ?? []).map((m) => (
        <div key={`${m.stableId}-${m.counted}`} className="flow__row" style={{ paddingLeft: (depth + 1) * 22 }}>
          <span className="flow__branch">↳</span>
          <AttachedChip
            member={m}
            node={nodeByStable.get(m.stableId)}
            current={nodeByStable.get(m.stableId)?.id === currentNodeId}
            onSelect={onSelectNode}
          />
        </div>
      ))}
    </div>
  );
  return (
    <div className="flow__tree">
      {buildOrphanLayout(unit.memberStableIds, nodeByStable).map((g) => (
        <div key={g.dir ?? "(flat)"}>
          {g.dir !== null && (
            <div className="unit__dir" data-testid="orphan-dir">
              {g.dir}/
            </div>
          )}
          {g.entries.map((e) => (
            <div key={e.node.id}>
              {renderNode(e.node, g.dir !== null ? 1 : 0)}
              {e.nested.map((r) => renderNode(r, g.dir !== null ? 2 : 1))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

type TrackRow = { kind: "step"; step: FlowStep; index: number } | { kind: "run"; steps: FlowStep[]; index: number };

/** Group consecutive off-path context steps into one collapsible run. */
function trackRows(steps: FlowStep[]): TrackRow[] {
  const rows: TrackRow[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s) continue;
    if (!s.offPath) {
      rows.push({ kind: "step", step: s, index: i });
      continue;
    }
    const run: FlowStep[] = [s];
    while (i + 1 < steps.length) {
      const next = steps[i + 1];
      if (!next?.offPath) break;
      run.push(next);
      i++;
    }
    rows.push({ kind: "run", steps: run, index: i - run.length + 1 });
  }
  return rows;
}

function FlowTrack({
  flow,
  attachedByParent,
  nodeByStable,
  currentNodeId,
  onSelectNode,
}: {
  flow: Flow;
  attachedByParent?: Map<string, AttachedMember[]>;
  nodeByStable?: Map<string, Node>;
  currentNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Attachments render at their parent's first occurrence in this track only
  // (a shared callee repeats under each caller; its nested test shouldn't).
  const attachmentsRendered = new Set<string>();
  const renderStep = (s: FlowStep, key: string) => {
    const attached =
      attachedByParent && !attachmentsRendered.has(s.stableId) ? (attachedByParent.get(s.stableId) ?? []) : [];
    if (attached.length > 0) attachmentsRendered.add(s.stableId);
    return (
      <div key={key}>
        <div className="flow__row" style={{ paddingLeft: s.depth * 22 }}>
          {s.depth > 0 && <span className="flow__branch">└</span>}
          <StepChip step={s} current={!!s.nodeId && s.nodeId === currentNodeId} onSelect={onSelectNode} />
        </div>
        {attached.map((m) => (
          <div key={`${m.stableId}-${m.counted}`} className="flow__row" style={{ paddingLeft: (s.depth + 1) * 22 }}>
            <span className="flow__branch">↳</span>
            <AttachedChip
              member={m}
              node={nodeByStable?.get(m.stableId)}
              current={nodeByStable?.get(m.stableId)?.id === currentNodeId}
              onSelect={onSelectNode}
            />
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="flow__tree">
      {trackRows(flow.steps).map((row) => {
        if (row.kind === "step") return renderStep(row.step, `s-${row.index}`);
        if (expanded.has(row.index)) return row.steps.map((s, j) => renderStep(s, `s-${row.index}-${j}`));
        const [first] = row.steps;
        if (!first) return null;
        return (
          <div key={`run-${row.index}`} className="flow__row" style={{ paddingLeft: first.depth * 22 }}>
            <button className="flow__collapsed" onClick={() => setExpanded((e) => new Set(e).add(row.index))}>
              ⋯ {row.steps.length} unchanged call{row.steps.length === 1 ? "" : "s"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** A server-attached member (test / DTO / residual) under its parent node.
 *  counted=false renders dimmed as a cross-unit reference (jump link only). */
function AttachedChip({
  member,
  node,
  current,
  onSelect,
}: {
  member: AttachedMember;
  node: Node | undefined;
  current: boolean;
  onSelect: (nodeId: string) => void;
}) {
  if (!node) return null;
  const residual = node.residualKind ? RESIDUAL_KIND[node.residualKind] : null;
  const cls = [
    "step",
    "step--attached",
    node.changeStatus === "changed" ? "step--changed" : "",
    node.isTest ? "step--test" : "",
    node.reviewStatus !== "unreviewed" ? "step--reviewed" : "",
    member.counted ? "" : "step--ref",
    residual ? "step--residual" : "",
    current ? "step--current" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const base = member.counted
    ? `${node.file}:${node.startLine} — attached: ${member.reason}`
    : `${node.file}:${node.startLine} — ${member.reason} reference; reviewed in its home unit`;
  const title = residual ? `${base}. ${residual.title}` : base;
  return (
    <button
      className={cls}
      data-testid={`attached-${member.counted ? "member" : "ref"}`}
      onClick={() => onSelect(node.id)}
      title={title}
    >
      {node.label}
      {node.reviewStatus === "reviewed-commented" && <CommentMark />}
      {residual && <span className="step__kind">{residual.badge}</span>}
      <span className="step__reason">{member.counted ? member.reason : `${member.reason} →`}</span>
    </button>
  );
}

function StepChip({
  step,
  current,
  onSelect,
}: {
  step: FlowStep;
  current: boolean;
  onSelect: (nodeId: string) => void;
}) {
  const residual = step.residualKind ? RESIDUAL_KIND[step.residualKind] : null;
  const cls = [
    "step",
    step.changeStatus === "changed" ? "step--changed" : "",
    step.changeStatus === null ? "step--ext" : "",
    step.isTest ? "step--test" : "",
    step.reviewStatus && step.reviewStatus !== "unreviewed" ? "step--reviewed" : "",
    residual ? "step--residual" : "",
    current ? "step--current" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      className={cls}
      disabled={!step.nodeId}
      onClick={() => step.nodeId && onSelect(step.nodeId)}
      title={residual ? `${step.file}:${step.startLine} — ${residual.title}` : `${step.file}:${step.startLine}`}
    >
      {step.label}
      {step.reviewStatus === "reviewed-commented" && <CommentMark />}
      {residual && <span className="step__kind">{residual.badge}</span>}
    </button>
  );
}

/** Marks a plan chip whose node carries comments, so a reviewer can spot and
 *  return to their commented chunks from the unit view. */
function CommentMark() {
  return (
    <span className="step__comment" data-testid="comment-mark" title="has comments">
      ✱
    </span>
  );
}

const wrap: React.CSSProperties = {
  flex: 1,
  height: "100%",
  display: "flex",
  flexDirection: "column",
  background: "var(--panel)",
  minHeight: 0,
};
const head: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  padding: "14px 16px 10px",
  borderBottom: "1px solid var(--line)",
};
const empty: React.CSSProperties = {
  flex: 1,
  height: "100%",
  display: "grid",
  placeItems: "center",
  background: "var(--panel)",
};
const warnBanner: React.CSSProperties = {
  margin: "8px 16px 0",
  padding: "8px 12px",
  borderRadius: 6,
  background: "rgba(230, 160, 30, 0.12)",
  border: "1px solid rgba(230, 160, 30, 0.35)",
  fontSize: 13,
  lineHeight: 1.5,
};
