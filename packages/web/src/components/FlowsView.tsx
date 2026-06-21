import { useFlows } from "../api/hooks.js";
import type { Flow, FlowStep } from "../api/client.js";

/**
 * EXPERIMENT: review a change as the set of execution flows it touches.
 * Each flow is a left→right track of steps (entry point → leaf). Flows that
 * pass through a changed node are surfaced first; steps that map to a session
 * node are clickable and load that node's diff in the shared panel.
 */
export function FlowsView({
  sessionId,
  currentNodeId,
  onSelectNode,
}: {
  sessionId: string;
  currentNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  const { data, isLoading } = useFlows(sessionId);
  const flows = data?.flows ?? [];
  const affected = flows.filter((f) => f.affected).length;

  if (!isLoading && flows.length === 0) {
    return (
      <div style={empty}>
        <div style={{ maxWidth: 320, textAlign: "center" }}>
          <div style={{ fontSize: 26, marginBottom: 10, opacity: 0.5 }}>⇉</div>
          <h2 style={{ fontSize: 16, marginBottom: 6 }}>No execution flows</h2>
          <p style={{ color: "var(--dim)", fontSize: 13, lineHeight: 1.6, margin: 0 }}>
            CRG hasn't traced any flows for this graph. Build the graph with flow
            post-processing, or use the call-graph view.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={wrap}>
      <div style={head}>
        <span style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 15 }}>Execution flows</span>
        <span style={{ color: "var(--dim)", fontSize: 13 }}>
          {affected} affected <span style={{ color: "var(--faint)" }}>/ {flows.length}</span>
        </span>
      </div>
      <div style={{ overflow: "auto", flex: 1, padding: "4px 16px 20px" }}>
        {flows.map((f) => (
          <FlowTrack key={f.id} flow={f} currentNodeId={currentNodeId} onSelectNode={onSelectNode} />
        ))}
      </div>
    </div>
  );
}

function FlowTrack({
  flow,
  currentNodeId,
  onSelectNode,
}: {
  flow: Flow;
  currentNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  return (
    <div className={`flow${flow.affected ? " flow--affected" : ""}`}>
      <div className="flow__bar">
        <span className="flow__name">{flow.name}</span>
        {flow.affected && <span className="flow__badge">affected</span>}
        <span className="flow__crit" title="CRG criticality score">
          crit {flow.criticality.toFixed(2)}
        </span>
        <span className="flow__len">{flow.steps.length} steps</span>
      </div>
      <div className="flow__track">
        {flow.steps.map((s, i) => (
          <span key={i} style={{ display: "contents" }}>
            {i > 0 && <span className="flow__arrow">→</span>}
            <StepChip step={s} current={!!s.nodeId && s.nodeId === currentNodeId} onSelect={onSelectNode} />
          </span>
        ))}
      </div>
    </div>
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
  const cls = [
    "step",
    step.changeStatus === "changed" ? "step--changed" : "",
    step.changeStatus === null ? "step--ext" : "",
    step.isTest ? "step--test" : "",
    step.reviewStatus && step.reviewStatus !== "unreviewed" ? "step--reviewed" : "",
    current ? "step--current" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const clickable = !!step.nodeId;
  return (
    <button
      className={cls}
      disabled={!clickable}
      onClick={() => step.nodeId && onSelect(step.nodeId)}
      title={`${step.file}:${step.startLine}`}
    >
      {step.label}
    </button>
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
