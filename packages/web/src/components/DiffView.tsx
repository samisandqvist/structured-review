import ReactDiffViewer from "react-diff-viewer-continued";
import type { Node } from "../api/client.js";
import { NodeBadge } from "./NodeBadge.js";

export function DiffView({ node }: { node: Node }) {
  const oldCode = `// ${node.label} — before (line ${node.startLine})\n// ... original code ...`;
  const newCode = node.changeStatus === "changed"
    ? `// ${node.label} — after (line ${node.startLine})\n// ... new code ...`
    : oldCode;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "4px 0", display: "flex", alignItems: "center", gap: "8px" }}>
        <strong>{node.label}</strong>
        <NodeBadge status={node.reviewStatus} />
        {node.changeStatus === "unchanged" && <span style={{ fontSize: "0.7rem", color: "#888" }}>unchanged</span>}
        <span style={{ fontSize: "0.8rem", color: "#888" }}>{node.file}:{node.startLine}-{node.endLine}</span>
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        <ReactDiffViewer oldValue={oldCode} newValue={newCode} splitView hideLineNumbers={false} />
      </div>
    </div>
  );
}
