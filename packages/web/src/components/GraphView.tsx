import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import dagre from "@dagrejs/dagre";
import { useNodes } from "../api/hooks.js";
import type { Node, GraphEdgeDTO } from "../api/client.js";

const LED: Record<Node["reviewStatus"], string> = {
  unreviewed: "var(--led-unreviewed)",
  "reviewed-clean": "var(--led-clean)",
  "reviewed-commented": "var(--led-commented)",
  "reviewed-elsewhere": "var(--led-elsewhere)",
};

const NODE_W = 188;
const NODE_H = 62;

type TraceData = {
  label: string;
  file: string;
  reviewStatus: Node["reviewStatus"];
  changeStatus: Node["changeStatus"];
  isCurrent: boolean;
  isTest: boolean;
  testCount: number;
  hiddenCallees: number;
  expanded: boolean;
  expandable: boolean;
  onToggle: (id: string) => void;
  nodeId: string;
};

/** A node rendered as an instrument readout: status LED, label, source location,
 *  a test count, and an expand control when it has undisclosed callees. */
function TraceNode({ data }: NodeProps) {
  const d = data as TraceData;
  const cls = [
    "tnode",
    d.isCurrent ? "tnode--current" : "",
    d.changeStatus === "unchanged" ? "tnode--unchanged" : "",
    d.isTest ? "tnode--test" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls}>
      <Handle type="target" position={Position.Top} className="tnode__handle" />
      <div className="tnode__top">
        <span className="tnode__led" style={{ color: LED[d.reviewStatus] }} />
        <span className="tnode__label">
          {d.isTest && <span className="tnode__flask">🧪</span>}
          {d.label}
        </span>
        {d.testCount > 0 && !d.isTest && (
          <span className="tnode__tests" title={`${d.testCount} test(s)`}>
            🧪 {d.testCount}
          </span>
        )}
      </div>
      <div className="tnode__file">{d.file}</div>
      {d.expandable && (
        <button
          className="tnode__expand"
          onClick={(e) => {
            e.stopPropagation();
            d.onToggle(d.nodeId);
          }}
          title={d.expanded ? "Collapse callees" : `Expand ${d.hiddenCallees} callee(s)`}
        >
          {d.expanded ? "▾ callees" : `▸ ${d.hiddenCallees}`}
        </button>
      )}
      <Handle type="source" position={Position.Bottom} className="tnode__handle" />
    </div>
  );
}

const nodeTypes = { trace: TraceNode };

// Floor the fit zoom so wide changes stay readable (and pannable) instead of
// shrinking to an illegible band; cap it so tiny graphs don't balloon.
const FIT_OPTS = { padding: 0.2, minZoom: 0.5, maxZoom: 1.2, duration: 200 } as const;

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

  const [showTests, setShowTests] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const seededRef = useRef(false);

  const onToggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const focusOn = useCallback(
    (id: string) => {
      setFocusId(id);
      onSelectNode(id);
    },
    [onSelectNode]
  );

  const allNodes = useMemo(() => data?.nodes ?? [], [data]);
  const allEdges = useMemo(() => data?.edges ?? [], [data]);

  // Structural graph (call edges, plus test edges only when tests are shown),
  // visibility via progressive disclosure or focus, and a dagre layout.
  const layout = useMemo(
    () => computeLayout(allNodes, allEdges, { showTests, expanded, currentNodeId, onToggle, focusId }),
    [allNodes, allEdges, showTests, expanded, currentNodeId, onToggle, focusId]
  );

  // Seed the initial disclosure: roots expanded one level.
  useEffect(() => {
    if (!seededRef.current && allNodes.length > 0) {
      setExpanded(new Set(layout.rootIds));
      seededRef.current = true;
    }
  }, [allNodes.length, layout.rootIds]);

  // Re-fit when the visible set changes or the pane resizes (debounced).
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    let timer = 0;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(() => rfRef.current?.fitView(FIT_OPTS), 120);
    });
    observer.observe(el);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, []);
  useEffect(() => {
    const t = window.setTimeout(() => rfRef.current?.fitView(FIT_OPTS), 60);
    return () => clearTimeout(t);
  }, [layout.flowNodes.length]);

  if (allNodes.length === 0) {
    return (
      <div className="graph-empty" style={emptyStyle}>
        No nodes in this session
      </div>
    );
  }

  return (
    <div ref={wrapperRef} style={{ flex: 1, position: "relative", height: "100%", minHeight: 0 }}>
      <ReactFlow
        nodeTypes={nodeTypes}
        nodes={layout.flowNodes}
        edges={layout.flowEdges}
        onInit={(inst) => {
          rfRef.current = inst;
        }}
        onNodeClick={(_, n) => onSelectNode(n.id)}
        onNodeDoubleClick={(_, n) => focusOn(n.id)}
        fitView
        fitViewOptions={FIT_OPTS}
        proOptions={{ hideAttribution: true }}
        minZoom={0.12}
      >
        <Background variant={BackgroundVariant.Dots} gap={26} size={1} color="#222b3a" />
        <Controls showInteractive={false} />
      </ReactFlow>
      <ControlPanel
        showTests={showTests}
        onToggleTests={() => setShowTests((v) => !v)}
        testTotal={layout.testTotal}
        onExpandAll={() => setExpanded(new Set(layout.expandableIds))}
        onCollapse={() => setExpanded(new Set())}
        shown={layout.flowNodes.length}
        total={layout.candidateTotal}
        entryPoints={layout.entryPoints}
        focusId={focusId}
        focusLabel={layout.focusLabel}
        onFocus={focusOn}
        onClearFocus={() => setFocusId(null)}
      />
      <Legend />
    </div>
  );
}

interface LayoutArgs {
  showTests: boolean;
  expanded: Set<string>;
  currentNodeId: string | null;
  onToggle: (id: string) => void;
  focusId: string | null;
}

function computeLayout(nodes: Node[], edges: GraphEdgeDTO[], args: LayoutArgs) {
  const { showTests, expanded, currentNodeId, onToggle } = args;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const callEdges = edges.filter((e) => e.edgeType === "call");
  const testEdges = edges.filter((e) => e.edgeType === "test");

  // How many tests each node has (TESTED_BY: source = tested node).
  const testCount = new Map<string, number>();
  for (const e of testEdges) testCount.set(e.sourceNodeId, (testCount.get(e.sourceNodeId) ?? 0) + 1);

  const isCandidate = (n: Node) => showTests || !n.isTest;
  const candidates = nodes.filter(isCandidate);
  const candidateIds = new Set(candidates.map((n) => n.id));
  const focusId = args.focusId && candidateIds.has(args.focusId) ? args.focusId : null;

  const structural = [...callEdges, ...(showTests ? testEdges : [])].filter(
    (e) => candidateIds.has(e.sourceNodeId) && candidateIds.has(e.targetNodeId)
  );

  // Call-graph adjacency (callees) and reverse (callers), independent of tests.
  const callees = new Map<string, string[]>();
  const callIncoming = new Map<string, number>();
  for (const id of candidateIds) {
    callees.set(id, []);
    callIncoming.set(id, 0);
  }
  for (const e of callEdges) {
    if (!candidateIds.has(e.sourceNodeId) || !candidateIds.has(e.targetNodeId)) continue;
    callees.get(e.sourceNodeId)!.push(e.targetNodeId);
    callIncoming.set(e.targetNodeId, (callIncoming.get(e.targetNodeId) ?? 0) + 1);
  }

  // children over the full structural graph (drives the expand affordance).
  const children = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  for (const id of candidateIds) {
    children.set(id, []);
    incoming.set(id, 0);
  }
  for (const e of structural) {
    children.get(e.sourceNodeId)!.push(e.targetNodeId);
    incoming.set(e.targetNodeId, (incoming.get(e.targetNodeId) ?? 0) + 1);
  }

  const rootIds = candidates.filter((n) => (incoming.get(n.id) ?? 0) === 0).map((n) => n.id);
  const expandableIds = candidates.filter((n) => (children.get(n.id)?.length ?? 0) > 0).map((n) => n.id);

  // Entry points = changed, non-test roots (nothing calls them) that actually
  // head a call tree (≥1 callee). Isolated changed leaves aren't useful focus
  // targets, so they're left out of the picker (still visible in the graph).
  const entryPoints = candidates
    .filter(
      (n) =>
        !n.isTest &&
        n.changeStatus === "changed" &&
        (callIncoming.get(n.id) ?? 0) === 0 &&
        (callees.get(n.id)?.length ?? 0) > 0
    )
    .map((n) => ({ id: n.id, label: n.label, file: n.file, callees: callees.get(n.id)?.length ?? 0 }))
    .sort((a, b) => b.callees - a.callees);

  // Focus pins the view to one node: it and its direct callers (context) become
  // the roots, and the focus node starts expanded so its callees show; from
  // there the normal expand/collapse applies, so you can explore deeper.
  const focusCallers: string[] = [];
  if (focusId) {
    for (const e of callEdges) {
      if (e.targetNodeId === focusId && candidateIds.has(e.sourceNodeId)) focusCallers.push(e.sourceNodeId);
    }
  }
  const roots = focusId ? [focusId, ...focusCallers] : rootIds;
  const isExpanded = (id: string) => id === focusId || expanded.has(id);

  const visible = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length) {
    const id = queue.shift()!;
    if (!isExpanded(id)) continue;
    for (const c of children.get(id) ?? []) {
      if (!visible.has(c)) {
        visible.add(c);
        queue.push(c);
      }
    }
  }

  const visNodes = candidates.filter((n) => visible.has(n.id));
  const visEdges = structural.filter((e) => visible.has(e.sourceNodeId) && visible.has(e.targetNodeId));

  // dagre layered layout: callers above, callees below.
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 26, ranksep: 64, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of visNodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of visEdges) g.setEdge(e.sourceNodeId, e.targetNodeId);
  dagre.layout(g);

  const flowNodes: FlowNode[] = visNodes.map((n) => {
    const pos = g.node(n.id);
    const childIds = children.get(n.id) ?? [];
    const hiddenCallees = childIds.filter((c) => !visible.has(c)).length;
    return {
      id: n.id,
      type: "trace",
      position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      data: {
        label: n.label,
        file: `${n.file}:${n.startLine}`,
        reviewStatus: n.reviewStatus,
        changeStatus: n.changeStatus,
        isCurrent: n.id === currentNodeId,
        isTest: n.isTest,
        testCount: testCount.get(n.id) ?? 0,
        hiddenCallees,
        expanded: isExpanded(n.id),
        expandable: childIds.length > 0,
        onToggle,
        nodeId: n.id,
      } satisfies TraceData,
    };
  });

  const flowEdges: FlowEdge[] = visEdges.map((e) => {
    const live = e.sourceNodeId === currentNodeId || e.targetNodeId === currentNodeId;
    return {
      id: `${e.edgeType}-${e.sourceNodeId}-${e.targetNodeId}`,
      source: e.sourceNodeId,
      target: e.targetNodeId,
      className: [e.edgeType === "test" ? "is-test" : "", live ? "is-live" : ""].filter(Boolean).join(" ") || undefined,
      animated: live && e.edgeType === "call",
    };
  });

  let testTotal = 0;
  for (const v of testCount.values()) testTotal += v;

  return {
    flowNodes,
    flowEdges,
    rootIds,
    expandableIds,
    entryPoints,
    focusLabel: focusId ? byId.get(focusId)?.label ?? null : null,
    testTotal: nodes.filter((n) => n.isTest).length,
    candidateTotal: candidates.length,
  };
}

interface EntryPoint {
  id: string;
  label: string;
  file: string;
  callees: number;
}

function ControlPanel({
  showTests,
  onToggleTests,
  testTotal,
  onExpandAll,
  onCollapse,
  shown,
  total,
  entryPoints,
  focusId,
  focusLabel,
  onFocus,
  onClearFocus,
}: {
  showTests: boolean;
  onToggleTests: () => void;
  testTotal: number;
  onExpandAll: () => void;
  onCollapse: () => void;
  shown: number;
  total: number;
  entryPoints: EntryPoint[];
  focusId: string | null;
  focusLabel: string | null;
  onFocus: (id: string) => void;
  onClearFocus: () => void;
}) {
  return (
    <div className="graph-controls">
      <div className="graph-controls__row">
        <span className="graph-controls__count">
          {shown}
          <span style={{ color: "var(--faint)" }}>/{total}</span> shown
        </span>
      </div>

      {focusId ? (
        <div className="graph-focus">
          <span className="graph-focus__label" title={focusLabel ?? ""}>
            ⊙ {focusLabel}
          </span>
          <button className="chip chip--clear" onClick={onClearFocus} title="Clear focus">
            ✕ clear
          </button>
        </div>
      ) : (
        <div className="graph-controls__row">
          <button className="chip" onClick={onExpandAll}>Expand all</button>
          <button className="chip" onClick={onCollapse}>Collapse</button>
        </div>
      )}

      {entryPoints.length > 0 && (
        <details className="graph-entries" open={!focusId}>
          <summary>Entry points ({entryPoints.length})</summary>
          <div className="graph-entries__list">
            {entryPoints.map((ep) => (
              <button
                key={ep.id}
                className={`graph-entries__item${ep.id === focusId ? " is-active" : ""}`}
                onClick={() => onFocus(ep.id)}
                title={`${ep.label} — ${ep.file}`}
              >
                <span className="graph-entries__name">{ep.label}</span>
                <span className="graph-entries__count">{ep.callees}</span>
              </button>
            ))}
          </div>
        </details>
      )}

      <label className="graph-controls__toggle">
        <input type="checkbox" checked={showTests} onChange={onToggleTests} />
        <span>Show tests{testTotal > 0 ? ` (${testTotal})` : ""}</span>
      </label>
      <span className="graph-controls__hint">double-click a node to focus</span>
    </div>
  );
}

function Legend() {
  const items: [string, string][] = [
    ["unreviewed", "var(--led-unreviewed)"],
    ["clean", "var(--led-clean)"],
    ["commented", "var(--led-commented)"],
    ["elsewhere", "var(--led-elsewhere)"],
  ];
  return (
    <div className="graph-legend">
      <span style={{ color: "var(--dim)", fontSize: 13, letterSpacing: "0.1em" }}>STATUS</span>
      {items.map(([label, color]) => (
        <div key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{ width: 8, height: 8, borderRadius: "50%", background: color, boxShadow: `0 0 5px ${color}` }}
          />
          <span style={{ fontSize: 13, color: "var(--dim)" }}>{label}</span>
        </div>
      ))}
    </div>
  );
}

const emptyStyle: React.CSSProperties = {
  flex: 1,
  height: "100%",
  display: "grid",
  placeItems: "center",
  color: "var(--faint)",
  background: "var(--panel)",
};
