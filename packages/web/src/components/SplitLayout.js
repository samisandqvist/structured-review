import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useRef, useCallback } from "react";
import { useUIStore } from "../store/ui.js";
import { useNode, useUpdateNodeStatus } from "../api/hooks.js";
import { FlowsView } from "./FlowsView.js";
import { DiffView } from "./DiffView.js";
import { CommentBox } from "./CommentBox.js";
export function SplitLayout({ sessionId, currentNodeId, }) {
    const splitRatio = useUIStore((s) => s.splitRatio);
    const setSplitRatio = useUIStore((s) => s.setSplitRatio);
    const setCurrentNode = useUIStore((s) => s.setCurrentNode);
    const containerRef = useRef(null);
    const { data: nodeData } = useNode(sessionId, currentNodeId);
    const updateStatus = useUpdateNodeStatus(sessionId);
    const handleMouseDown = useCallback(() => {
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        const onMove = (e) => {
            if (!containerRef.current)
                return;
            const rect = containerRef.current.getBoundingClientRect();
            setSplitRatio((e.clientX - rect.left) / rect.width);
        };
        const onUp = () => {
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    }, [setSplitRatio]);
    const currentNode = nodeData?.node;
    return (_jsx("div", { style: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }, children: _jsxs("div", { ref: containerRef, style: { flex: 1, display: "flex", overflow: "hidden" }, children: [_jsx("div", { style: { flex: splitRatio, overflow: "hidden", height: "100%" }, children: _jsx(FlowsView, { sessionId: sessionId, currentNodeId: currentNodeId, onSelectNode: setCurrentNode }) }), _jsx(Divider, { onMouseDown: handleMouseDown }), _jsx("div", { style: {
                        flex: 1 - splitRatio,
                        display: "flex",
                        flexDirection: "column",
                        overflow: "hidden",
                        background: "var(--ink)",
                        borderLeft: "1px solid var(--line)",
                    }, children: currentNode ? (_jsxs(_Fragment, { children: [_jsx("div", { style: { flex: 1, overflow: "auto", padding: "12px 14px" }, children: _jsx(DiffView, { node: currentNode, diff: nodeData?.diff }) }), _jsx("div", { style: {
                                    display: "flex",
                                    gap: 10,
                                    padding: "12px 16px",
                                    borderTop: "1px solid var(--line)",
                                    background: "var(--panel)",
                                }, children: _jsx("button", { className: "btn btn--clean btn--lg", onClick: () => updateStatus.mutate({
                                        nodeId: currentNode.id,
                                        reviewStatus: "reviewed-clean",
                                    }), children: "\u2713 Mark reviewed" }) }), _jsx(CommentBox, { sessionId: sessionId, nodeId: currentNode.id })] })) : (_jsx(EmptyState, {})) })] }) }));
}
function Divider({ onMouseDown }) {
    return (_jsx("div", { onMouseDown: onMouseDown, role: "separator", "aria-orientation": "vertical", style: {
            width: 9,
            flexShrink: 0,
            cursor: "col-resize",
            display: "grid",
            placeItems: "center",
            background: "var(--ink)",
        }, children: _jsx("div", { style: {
                width: 2,
                height: 34,
                borderRadius: 2,
                background: "var(--line-bright)",
            } }) }));
}
function EmptyState() {
    return (_jsx("div", { style: {
            flex: 1,
            display: "grid",
            placeItems: "center",
            padding: 24,
            textAlign: "center",
        }, children: _jsxs("div", { style: { maxWidth: 280 }, children: [_jsx("div", { style: { fontSize: 28, marginBottom: 12, opacity: 0.5 }, children: "\u2316" }), _jsx("h2", { style: { fontSize: 17, marginBottom: 6 }, children: "Pick a node to start the walk" }), _jsx("p", { style: { color: "var(--dim)", fontSize: 15, lineHeight: 1.6, margin: 0 }, children: "The graph is the change, laid out by call depth \u2014 callers on top, callees below. Select any node to read its diff and leave a comment." })] }) }));
}
//# sourceMappingURL=SplitLayout.js.map