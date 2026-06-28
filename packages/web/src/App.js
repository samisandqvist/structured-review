import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useUIStore } from "./store/ui.js";
import { useNodes, useSession } from "./api/hooks.js";
import { SplitLayout } from "./components/SplitLayout.js";
const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 1000, refetchOnWindowFocus: false } },
});
export function App() {
    return (_jsx(QueryClientProvider, { client: queryClient, children: _jsx(ReviewShell, {}) }));
}
function ReviewShell() {
    const currentNodeId = useUIStore((s) => s.currentNodeId);
    const sessionId = new URLSearchParams(window.location.search).get("session") ?? "placeholder";
    return (_jsxs("div", { style: { height: "100vh", display: "flex", flexDirection: "column" }, children: [_jsx(StatusBar, { sessionId: sessionId }), _jsx(SplitLayout, { sessionId: sessionId, currentNodeId: currentNodeId })] }));
}
/** The header reads like an instrument status line: who we are, what branch /
 *  unit is under the lens, and how far the walk has gotten. */
function StatusBar({ sessionId }) {
    const { data: sessionData } = useSession(sessionId);
    const { data: nodeData } = useNodes(sessionId);
    const session = sessionData?.session;
    const unit = sessionData?.units?.[0];
    const nodes = nodeData?.nodes ?? [];
    const changed = nodes.filter((n) => n.changeStatus === "changed");
    const reviewed = changed.filter((n) => n.reviewStatus !== "unreviewed").length;
    const total = changed.length;
    const pct = total > 0 ? Math.round((reviewed / total) * 100) : 0;
    return (_jsxs("header", { className: "statusbar", children: [_jsxs("div", { className: "statusbar__brand", children: [_jsx(TraceMark, {}), _jsx("span", { style: {
                            fontFamily: "var(--display)",
                            fontWeight: 700,
                            fontSize: 17,
                            letterSpacing: "-0.01em",
                        }, children: "Trace" }), _jsx("span", { className: "statusbar__sub", style: { color: "var(--dim)", fontSize: 15, marginTop: 1 }, children: "code review walkthrough" })] }), _jsx(Field, { label: "branch", children: session?.branch ?? "—" }), unit && (_jsx(Field, { label: "unit", className: "statusbar__field--unit", children: unit.label })), _jsx("div", { style: { flex: 1, minWidth: 8 } }), total > 0 && (_jsxs("div", { className: "statusbar__progress", children: [_jsx("span", { className: "statusbar__progress-label", style: { color: "var(--dim)", fontSize: 13, letterSpacing: "0.08em" }, children: "REVIEWED" }), _jsx("div", { className: "statusbar__meter", style: {
                            height: 6,
                            borderRadius: 3,
                            background: "var(--surface-2)",
                            overflow: "hidden",
                            border: "1px solid var(--line)",
                        }, children: _jsx("div", { style: {
                                width: `${pct}%`,
                                height: "100%",
                                background: "var(--trace)",
                                boxShadow: "0 0 8px var(--trace-glow)",
                                transition: "width 0.3s ease",
                            } }) }), _jsxs("span", { style: { fontSize: 15, fontWeight: 500, fontVariantNumeric: "tabular-nums" }, children: [reviewed, _jsxs("span", { style: { color: "var(--dim)" }, children: ["/", total] })] })] }))] }));
}
function Field({ label, className, children, }) {
    return (_jsxs("div", { className: `statusbar__field${className ? ` ${className}` : ""}`, children: [_jsx("span", { style: { color: "var(--dim)", fontSize: 13, letterSpacing: "0.08em", flexShrink: 0 }, children: label.toUpperCase() }), _jsx("span", { className: "statusbar__field-value", style: { fontSize: 15, color: "var(--text)" }, children: children })] }));
}
/** A small downward-tracing glyph — a signal stepping through call depth. */
function TraceMark() {
    return (_jsxs("svg", { width: "18", height: "18", viewBox: "0 0 18 18", fill: "none", "aria-hidden": true, children: [_jsx("path", { d: "M3 3.5h4M3 9h8M3 14.5h5", stroke: "var(--trace)", strokeWidth: "1.6", strokeLinecap: "round" }), _jsx("circle", { cx: "14", cy: "9", r: "2", fill: "var(--trace)" }), _jsx("circle", { cx: "13", cy: "3.5", r: "1.4", fill: "var(--dim)" }), _jsx("circle", { cx: "10.5", cy: "14.5", r: "1.4", fill: "var(--dim)" })] }));
}
//# sourceMappingURL=App.js.map