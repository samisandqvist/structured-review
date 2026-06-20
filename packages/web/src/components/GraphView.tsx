import { useEffect, useRef } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  type Node as FlowNode,
  type Edge as FlowEdge,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useNodes } from "../api/hooks.js";
import type { Node } from "../api/client.js";

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

const LED: Record<Node["reviewStatus"], string> = {
  unreviewed: "var(--led-unreviewed)",
  "reviewed-clean": "var(--led-clean)",
  "reviewed-commented": "var(--led-commented)",
  "reviewed-elsewhere": "var(--led-elsewhere)",
};

type TraceData = {
  label: string;
  file: string;
  level: number;
  reviewStatus: Node["reviewStatus"];
  changeStatus: Node["changeStatus"];
  isCurrent: boolean;
};

/** A node rendered as an instrument readout: status LED, mono label, the
 *  source location, and the call depth (L0 = entry point, deeper = callee). */
function TraceNode({ data }: NodeProps) {
  const d = data as TraceData;
  const cls = [
    "tnode",
    d.isCurrent ? "tnode--current" : "",
    d.changeStatus === "unchanged" ? "tnode--unchanged" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls}>
      <Handle type="target" position={Position.Top} className="tnode__handle" />
      <div className="tnode__top">
        <span className="tnode__led" style={{ color: LED[d.reviewStatus] }} />
        <span className="tnode__label">{d.label}</span>
        <span className="tnode__depth">L{d.level}</span>
      </div>
      <div className="tnode__file">{d.file}</div>
      <Handle type="source" position={Position.Bottom} className="tnode__handle" />
    </div>
  );
}

const nodeTypes = { trace: TraceNode };

const NODE_SPACING_X = 230;
const NODE_SPACING_Y = 132;

export function GraphView({
  sessionId,
  currentNodeId,
  onSelectNode,
}: {
  sessionId: string;
  currentNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  const { data } = useNodes(sessionId);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const rfRef = useRef<ReactFlowInstance | null>(null);

  // Keep the graph framed as its container changes size — window resize or a
  // drag of the split divider both reshape the pane, and the view should follow.
  // Debounced so React Flow's own size store settles before we re-fit (fitting
  // against a stale width yields an under-zoomed, off-center view).
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    let timer = 0;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(
        () => rfRef.current?.fitView({ padding: 0.3, duration: 200 }),
        120
      );
    });
    observer.observe(el);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  const allNodes = data?.nodes ?? [];
  const allEdges = data?.edges ?? [];

  if (allNodes.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          height: "100%",
          display: "grid",
          placeItems: "center",
          color: "var(--faint)",
          background: "var(--panel)",
        }}
      >
        No nodes in this session
      </div>
    );
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

  const flowNodes: FlowNode[] = allNodes.map((n) => {
    const level = levels.get(n.id) ?? 0;
    const peers = nodesByLevel.get(level) ?? [n.id];
    const indexInLevel = peers.indexOf(n.id);
    const levelWidth = (peers.length - 1) * NODE_SPACING_X;
    return {
      id: n.id,
      type: "trace",
      position: {
        x: indexInLevel * NODE_SPACING_X - levelWidth / 2,
        y: level * NODE_SPACING_Y,
      },
      data: {
        label: n.label,
        file: `${n.file}:${n.startLine}`,
        level,
        reviewStatus: n.reviewStatus,
        changeStatus: n.changeStatus,
        isCurrent: n.id === currentNodeId,
      } satisfies TraceData,
    };
  });

  const flowEdges: FlowEdge[] = allEdges.map((e) => {
    const live =
      e.sourceNodeId === currentNodeId || e.targetNodeId === currentNodeId;
    return {
      id: `${e.sourceNodeId}-${e.targetNodeId}`,
      source: e.sourceNodeId,
      target: e.targetNodeId,
      className: live ? "is-live" : undefined,
      animated: live,
    };
  });

  return (
    <div
      ref={wrapperRef}
      style={{ flex: 1, position: "relative", height: "100%", minHeight: 0 }}
    >
      <ReactFlow
        nodeTypes={nodeTypes}
        nodes={flowNodes}
        edges={flowEdges}
        onInit={(inst) => {
          rfRef.current = inst;
        }}
        onNodeClick={(_, n) => onSelectNode(n.id)}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={26} size={1} color="#222b3a" />
        <Controls showInteractive={false} />
      </ReactFlow>
      <Legend />
    </div>
  );
}

/** A corner HUD reading off what the LEDs mean — the instrument's key. */
function Legend() {
  const items: [string, string][] = [
    ["unreviewed", "var(--led-unreviewed)"],
    ["clean", "var(--led-clean)"],
    ["commented", "var(--led-commented)"],
    ["elsewhere", "var(--led-elsewhere)"],
  ];
  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        display: "flex",
        flexDirection: "column",
        gap: 7,
        padding: "11px 13px",
        background: "rgba(15, 20, 30, 0.82)",
        backdropFilter: "blur(6px)",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-sm)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <span style={{ color: "var(--dim)", fontSize: 13, letterSpacing: "0.1em" }}>
        STATUS
      </span>
      {items.map(([label, color]) => (
        <div key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: color,
              boxShadow: `0 0 5px ${color}`,
            }}
          />
          <span style={{ fontSize: 15, color: "var(--dim)" }}>{label}</span>
        </div>
      ))}
    </div>
  );
}
