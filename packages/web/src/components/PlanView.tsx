import { useFlows, useNodes, useSession } from "../api/hooks.js";
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
            unit={u}
            flow={u.kind === "flow" ? flowByEntry.get(u.memberStableIds[0]) : undefined}
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
  unit, flow, nodeByStable, currentNodeId, onSelectNode,
}: {
  unit: Unit;
  flow?: Flow;
  nodeByStable: Map<string, Node>;
  currentNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  const memberNodes = unit.memberStableIds.map((s) => nodeByStable.get(s)).filter((n): n is Node => !!n);
  const reviewed = memberNodes.filter((n) => n.reviewStatus !== "unreviewed").length;

  return (
    <div className={`unit${unit.auto ? " unit--auto" : ""}`}>
      <div className="unit__bar">
        <h3 className="unit__name">{unit.label}</h3>
        {unit.auto && <span className="unit__badge">unassigned</span>}
        {memberNodes.length > 0 && (
          <span className="unit__progress">{reviewed}/{memberNodes.length}</span>
        )}
      </div>
      {unit.rationale && <p className="unit__rationale">{unit.rationale}</p>}

      {unit.kind === "flow" && flow ? (
        <FlowTrack flow={flow} currentNodeId={currentNodeId} onSelectNode={onSelectNode} />
      ) : (
        <div className="unit__chips">
          {memberNodes.map((n) => (
            <StepChip
              key={n.id}
              step={{
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

function FlowTrack({
  flow, currentNodeId, onSelectNode,
}: {
  flow: Flow;
  currentNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  return (
    <div className="flow__tree">
      {flow.steps.map((s, i) => (
        <div key={i} className="flow__row" style={{ paddingLeft: s.depth * 22 }}>
          {s.depth > 0 && <span className="flow__branch">└</span>}
          <StepChip step={s} current={!!s.nodeId && s.nodeId === currentNodeId} onSelect={onSelectNode} />
        </div>
      ))}
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
