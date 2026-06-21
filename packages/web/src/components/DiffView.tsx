import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued";
import type { Node, NodeDiff } from "../api/client.js";
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

export function DiffView({ node, diff }: { node: Node; diff?: NodeDiff }) {
  const oldCode = diff?.oldText ?? "";
  const newCode = diff?.newText ?? "";
  const hasContent = oldCode.length > 0 || newCode.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          paddingBottom: 11,
          flexWrap: "wrap",
        }}
      >
        <h2 style={{ fontSize: 17, fontFamily: "var(--mono)", fontWeight: 700 }}>
          {node.label}
        </h2>
        <NodeBadge status={node.reviewStatus} />
        {node.changeStatus === "unchanged" && (
          <span
            style={{
              fontSize: 13,
              color: "var(--dim)",
              border: "1px dashed var(--line-bright)",
              borderRadius: 4,
              padding: "1px 6px",
              letterSpacing: "0.04em",
            }}
          >
            context · unchanged
          </span>
        )}
        <span style={{ fontSize: 13, color: "var(--dim)", marginLeft: "auto" }}>
          {node.file}:{node.startLine}–{node.endLine}
        </span>
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {hasContent ? (
          <ReactDiffViewer
            oldValue={oldCode}
            newValue={newCode}
            splitView
            useDarkTheme
            compareMethod={DiffMethod.WORDS}
            showDiffOnly={false}
            hideLineNumbers={false}
            styles={diffStyles}
          />
        ) : (
          <div style={{ padding: 16, color: "var(--faint)", fontSize: 13 }}>
            No source available for this node.
          </div>
        )}
      </div>
    </div>
  );
}
