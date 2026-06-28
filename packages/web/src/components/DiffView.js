import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued";
import { NodeBadge } from "./NodeBadge.js";
/** Dark, instrument-matched theme for the side-by-side diff. */
const diffStyles = {
    variables: {
        dark: {
            diffViewerBackground: "#11151f",
            diffViewerColor: "#e8ecf4",
            addedBackground: "rgba(70, 211, 138, 0.13)",
            addedColor: "#cfeede",
            removedBackground: "rgba(248, 90, 90, 0.13)",
            removedColor: "#f4cfcb",
            wordAddedBackground: "rgba(70, 211, 138, 0.32)",
            wordRemovedBackground: "rgba(248, 90, 90, 0.32)",
            addedGutterBackground: "rgba(70, 211, 138, 0.10)",
            removedGutterBackground: "rgba(248, 90, 90, 0.10)",
            gutterBackground: "#0f141e",
            gutterBackgroundDark: "#0c111a",
            highlightBackground: "rgba(79, 214, 255, 0.10)",
            highlightGutterBackground: "rgba(79, 214, 255, 0.14)",
            codeFoldGutterBackground: "#161c28",
            codeFoldBackground: "#11151f",
            emptyLineBackground: "#0f141e",
            gutterColor: "#5c6678",
            addedGutterColor: "#7ee2a8",
            removedGutterColor: "#ff9a93",
            codeFoldContentColor: "#98a2b6",
            diffViewerTitleBackground: "#0f141e",
            diffViewerTitleColor: "#98a2b6",
            diffViewerTitleBorderColor: "#283143",
        },
    },
    line: { fontFamily: "var(--mono)", fontSize: "15px" },
    contentText: { fontFamily: "var(--mono)" },
    gutter: { fontFamily: "var(--mono)", fontSize: "13px" },
    diffContainer: {
        borderRadius: "8px",
        overflow: "hidden",
        border: "1px solid #283143",
    },
};
export function DiffView({ node, diff }) {
    const oldCode = diff?.oldText ?? "";
    const newCode = diff?.newText ?? "";
    const hasContent = oldCode.length > 0 || newCode.length > 0;
    return (_jsxs("div", { style: { display: "flex", flexDirection: "column", height: "100%" }, children: [_jsxs("div", { style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    paddingBottom: 11,
                    flexWrap: "wrap",
                }, children: [_jsx("h2", { style: { fontSize: 17, fontFamily: "var(--mono)", fontWeight: 700 }, children: node.label }), _jsx(NodeBadge, { status: node.reviewStatus }), node.changeStatus === "unchanged" && (_jsx("span", { style: {
                            fontSize: 13,
                            color: "var(--dim)",
                            border: "1px dashed var(--line-bright)",
                            borderRadius: 4,
                            padding: "1px 6px",
                            letterSpacing: "0.04em",
                        }, children: "context \u00B7 unchanged" })), _jsxs("span", { style: { fontSize: 13, color: "var(--dim)", marginLeft: "auto" }, children: [node.file, ":", node.startLine, "\u2013", node.endLine] })] }), _jsx("div", { style: { flex: 1, overflow: "auto" }, children: hasContent ? (_jsx(ReactDiffViewer, { oldValue: oldCode, newValue: newCode, splitView: true, useDarkTheme: true, compareMethod: DiffMethod.WORDS, showDiffOnly: false, hideLineNumbers: false, styles: diffStyles })) : (_jsx("div", { style: { padding: 16, color: "var(--faint)", fontSize: 13 }, children: "No source available for this node." })) })] }));
}
//# sourceMappingURL=DiffView.js.map