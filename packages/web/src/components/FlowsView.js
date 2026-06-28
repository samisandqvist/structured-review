import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useFlows } from "../api/hooks.js";
/**
 * EXPERIMENT: review a change as the set of execution flows it touches.
 * Each flow is a left→right track of steps (entry point → leaf). Flows that
 * pass through a changed node are surfaced first; steps that map to a session
 * node are clickable and load that node's diff in the shared panel.
 */
export function FlowsView({ sessionId, currentNodeId, onSelectNode, }) {
    const { data, isLoading } = useFlows(sessionId);
    const flows = data?.flows ?? [];
    const affected = flows.filter((f) => f.affected).length;
    if (!isLoading && flows.length === 0) {
        return (_jsx("div", { style: empty, children: _jsxs("div", { style: { maxWidth: 320, textAlign: "center" }, children: [_jsx("div", { style: { fontSize: 26, marginBottom: 10, opacity: 0.5 }, children: "\u21C9" }), _jsx("h2", { style: { fontSize: 16, marginBottom: 6 }, children: "No execution flows" }), _jsx("p", { style: { color: "var(--dim)", fontSize: 13, lineHeight: 1.6, margin: 0 }, children: "CRG hasn't traced any flows for this graph. Build the graph with flow post-processing, or use the call-graph view." })] }) }));
    }
    return (_jsxs("div", { style: wrap, children: [_jsxs("div", { style: head, children: [_jsx("span", { style: { fontFamily: "var(--display)", fontWeight: 700, fontSize: 15 }, children: "Execution flows" }), _jsxs("span", { style: { color: "var(--dim)", fontSize: 13 }, children: [affected, " affected ", _jsxs("span", { style: { color: "var(--faint)" }, children: ["/ ", flows.length] })] })] }), _jsx("div", { style: { overflow: "auto", flex: 1, padding: "4px 16px 20px" }, children: flows.map((f) => (_jsx(FlowTrack, { flow: f, currentNodeId: currentNodeId, onSelectNode: onSelectNode }, f.id))) })] }));
}
function FlowTrack({ flow, currentNodeId, onSelectNode, }) {
    return (_jsxs("div", { className: `flow${flow.affected ? " flow--affected" : ""}`, children: [_jsxs("div", { className: "flow__bar", children: [_jsx("span", { className: "flow__name", children: flow.name }), flow.affected && _jsx("span", { className: "flow__badge", children: "affected" }), _jsxs("span", { className: "flow__crit", title: "CRG criticality score", children: ["crit ", flow.criticality.toFixed(2)] }), _jsxs("span", { className: "flow__len", children: [flow.steps.length, " steps"] })] }), _jsx("div", { className: "flow__tree", children: flow.steps.map((s, i) => (_jsxs("div", { className: "flow__row", style: { paddingLeft: s.depth * 22 }, children: [s.depth > 0 && _jsx("span", { className: "flow__branch", children: "\u2514" }), _jsx(StepChip, { step: s, current: !!s.nodeId && s.nodeId === currentNodeId, onSelect: onSelectNode })] }, i))) })] }));
}
function StepChip({ step, current, onSelect, }) {
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
    return (_jsx("button", { className: cls, disabled: !clickable, onClick: () => step.nodeId && onSelect(step.nodeId), title: `${step.file}:${step.startLine}`, children: step.label }));
}
const wrap = {
    flex: 1,
    height: "100%",
    display: "flex",
    flexDirection: "column",
    background: "var(--panel)",
    minHeight: 0,
};
const head = {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    padding: "14px 16px 10px",
    borderBottom: "1px solid var(--line)",
};
const empty = {
    flex: 1,
    height: "100%",
    display: "grid",
    placeItems: "center",
    background: "var(--panel)",
};
//# sourceMappingURL=FlowsView.js.map