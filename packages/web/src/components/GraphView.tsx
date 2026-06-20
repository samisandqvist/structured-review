import { ReactFlow, Background, Controls, type Node as FlowNode, type Edge as FlowEdge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useNodes } from "../api/hooks.js";

function computeLevels(
  nodeIds: string[],
  edges: { sourceNodeId: string; targetNodeId: string }[]
): Map<string, number> {
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const id of nodeIds) {
    adjacency.set(id, []);
    inDegree.set(id, 0);
  }
  for (const e of edges) {
    if (adjacency.has(e.sourceNodeId) && adjacency.has(e.targetNodeId)) {
      adjacency.get(e.sourceNodeId)!.push(e.targetNodeId);
      inDegree.set(e.targetNodeId, (inDegree.get(e.targetNodeId) ?? 0) + 1);
    }
  }
  const levels = new Map<string, number>();
  const queue = nodeIds.filter((id) => (inDegree.get(id) ?? 0) === 0);
  for (const id of queue) levels.set(id, 0);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const level = levels.get(id) ?? 0;
    for (const callee of adjacency.get(id) ?? []) {
      const current = levels.get(callee);
      if (current === undefined || current < level + 1) {
        levels.set(callee, level + 1);
        queue.push(callee);
      }
    }
  }
  for (const id of nodeIds) {
    if (!levels.has(id)) levels.set(id, 0);
  }
  return levels;
}

export function GraphView({ sessionId, currentNodeId, onSelectNode }: {
  sessionId: string;
  currentNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  const { data } = useNodes(sessionId);

  const allNodes = data?.nodes ?? [];
  const allEdges = data?.edges ?? [];

  if (allNodes.length === 0) {
    return <div style={{ flex: 1, padding: "16px" }}>No nodes in this session</div>;
  }

  const levels = computeLevels(
    allNodes.map((n) => n.id),
    allEdges
  );

  const nodesByLevel = new Map<number, string[]>();
  for (const n of allNodes) {
    const level = levels.get(n.id) ?? 0;
    if (!nodesByLevel.has(level)) nodesByLevel.set(level, []);
    nodesByLevel.get(level)!.push(n.id);
  }

  const NODE_SPACING_X = 180;
  const NODE_SPACING_Y = 120;

  const flowNodes: FlowNode[] = allNodes.map((n) => {
    const level = levels.get(n.id) ?? 0;
    const peers = nodesByLevel.get(level) ?? [n.id];
    const indexInLevel = peers.indexOf(n.id);
    const levelWidth = (peers.length - 1) * NODE_SPACING_X;
    const isCurrent = n.id === currentNodeId;
    return {
      id: n.id,
      position: {
        x: indexInLevel * NODE_SPACING_X - levelWidth / 2,
        y: level * NODE_SPACING_Y,
      },
      data: { label: n.label },
      style: {
        background: isCurrent ? "#4a9aef" : "#fff",
        color: isCurrent ? "#fff" : "#000",
        border: isCurrent ? "2px solid #4a9aef" : "1px solid #999",
      },
    };
  });

  const flowEdges: FlowEdge[] = allEdges.map((e) => ({
    id: `${e.sourceNodeId}-${e.targetNodeId}`,
    source: e.sourceNodeId,
    target: e.targetNodeId,
  }));

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
        <ReactFlow nodes={flowNodes} edges={flowEdges} onNodeClick={(_, n) => onSelectNode(n.id)} fitView>
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}
