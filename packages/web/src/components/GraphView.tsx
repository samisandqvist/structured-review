import { ReactFlow, Background, Controls, type Node as FlowNode, type Edge as FlowEdge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useNode } from "../api/hooks.js";
import { useUIStore } from "../store/ui.js";
import { NodeBadge } from "./NodeBadge.js";
import type { Node } from "../api/client.js";

const NODE_COLORS: Record<string, string> = {
  current: "#4a9aef", reviewed: "#2a7a2a", frontier: "#8a7a2a", unchanged: "#555",
};

function nodeColor(node: Node, isCurrent: boolean): string {
  if (isCurrent) return NODE_COLORS.current;
  if (node.reviewStatus !== "unreviewed") return NODE_COLORS.reviewed;
  if (node.changeStatus === "unchanged") return NODE_COLORS.unchanged;
  return NODE_COLORS.frontier;
}

export function GraphView({ sessionId, currentNodeId, onSelectNode }: {
  sessionId: string;
  currentNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  const { data } = useNode(sessionId, currentNodeId);
  const overviewOpen = useUIStore((s) => s.overviewOpen);

  if (!data || !currentNodeId) {
    return <div style={{ flex: 1, padding: "16px" }}>Select a node to begin</div>;
  }

  const { node, callers, callees } = data;
  const flowNodes: FlowNode[] = [
    ...callers.map((n, i) => ({
      id: n.id, position: { x: 250, y: i * 80 },
      data: { label: n.label }, style: { background: nodeColor(n, false) },
    })),
    {
      id: node.id, position: { x: 250, y: callers.length * 80 + 40 },
      data: { label: node.label }, style: { background: nodeColor(node, true) },
    },
    ...callees.map((n, i) => ({
      id: n.id, position: { x: 250, y: (callers.length + 1) * 80 + 80 + i * 80 },
      data: { label: n.label }, style: { background: nodeColor(n, false) },
    })),
  ];
  const flowEdges: FlowEdge[] = [
    ...callers.map((n) => ({ id: `${n.id}-${node.id}`, source: n.id, target: node.id })),
    ...callees.map((n) => ({ id: `${node.id}-${n.id}`, source: node.id, target: n.id })),
  ];

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "4px 8px", display: "flex", alignItems: "center", gap: "8px" }}>
        <strong>{node.label}</strong>
        <NodeBadge status={node.reviewStatus} />
        <span style={{ fontSize: "0.8rem", color: "#888" }}>{node.file}:{node.startLine}</span>
      </div>
      <div style={{ flex: 1, position: "relative" }}>
        <ReactFlow nodes={flowNodes} edges={flowEdges} onNodeClick={(_, n) => onSelectNode(n.id)} fitView>
          <Background />
          <Controls />
        </ReactFlow>
      </div>
      {overviewOpen && (
        <div style={{ padding: "4px 8px", fontSize: "0.8rem", color: "#888" }}>Overview mini-map (full DAG — future)</div>
      )}
    </div>
  );
}
