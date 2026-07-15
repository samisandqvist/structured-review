import { useRef, useCallback, useEffect, useMemo, useState } from "react";
import { useUIStore } from "../store/ui.js";
import { useFlows, useNode, useNodes, useSession, useUpdateNodeStatus } from "../api/hooks.js";
import { buildWalkOrder, nextInWalk, nextUnreviewed } from "../walk-order.js";
import { PlanView } from "./PlanView.js";
import { DiffView } from "./DiffView.js";
import { CommentBox } from "./CommentBox.js";
import { RelationsPanel } from "./RelationsPanel.js";

export function SplitLayout({
  sessionId,
  currentNodeId,
}: {
  sessionId: string;
  currentNodeId: string | null;
}) {
  const splitRatio = useUIStore((s) => s.splitRatio);
  const setSplitRatio = useUIStore((s) => s.setSplitRatio);
  const setCurrentNode = useUIStore((s) => s.setCurrentNode);
  const containerRef = useRef<HTMLDivElement>(null);
  const { data: nodeData } = useNode(sessionId, currentNodeId);
  const updateStatus = useUpdateNodeStatus(sessionId);
  const [showKeys, setShowKeys] = useState(false);

  const { data: sessionData } = useSession(sessionId);
  const { data: flowsData } = useFlows(sessionId);
  const { data: nodesData } = useNodes(sessionId);
  const nodes = useMemo(() => nodesData?.nodes ?? [], [nodesData]);
  const order = useMemo(
    () => buildWalkOrder(sessionData?.units ?? [], flowsData?.flows ?? [], nodes),
    [sessionData, flowsData, nodes]
  );
  const walkStableIds = useMemo(() => new Set(order.map((e) => e.stableId)), [order]);
  const nodeLabel = useCallback(
    (id: string) => nodes.find((n) => n.id === id)?.label ?? id,
    [nodes]
  );

  const walkPath = useUIStore((s) => s.walkPath);
  const pushToWalkPath = useUIStore((s) => s.pushToWalkPath);
  const truncateWalkPath = useUIStore((s) => s.truncateWalkPath);

  // A walk move (plan click, j/k/n/r) ends any detour.
  const walkTo = useCallback((nodeId: string | null) => {
    truncateWalkPath(0);
    setCurrentNode(nodeId);
  }, [truncateWalkPath, setCurrentNode]);

  // A relation click is a detour: remember where we came from.
  const selectRelation = useCallback((nodeId: string) => {
    const cur = useUIStore.getState().currentNodeId;
    if (cur) pushToWalkPath(cur);
    setCurrentNode(nodeId);
  }, [pushToWalkPath, setCurrentNode]);

  const jumpToBreadcrumb = useCallback((index: number) => {
    const path = useUIStore.getState().walkPath;
    if (index < 0 || index >= path.length) return;
    setCurrentNode(path[index]);
    truncateWalkPath(index);
  }, [setCurrentNode, truncateWalkPath]);

  const goNextUnreviewed = useCallback(() => {
    const id = nextUnreviewed(order, nodes, useUIStore.getState().currentNodeId);
    if (id) walkTo(id);
  }, [order, nodes, walkTo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const cur = useUIStore.getState().currentNodeId;
      if (e.key === "j") {
        const id = nextInWalk(order, cur, 1);
        if (id) walkTo(id);
      } else if (e.key === "k") {
        const id = nextInWalk(order, cur, -1);
        if (id) walkTo(id);
      } else if (e.key === "n") {
        goNextUnreviewed();
      } else if (e.key === "r" && cur) {
        updateStatus.mutate({ nodeId: cur, reviewStatus: "reviewed-clean" }, { onSuccess: goNextUnreviewed });
      } else if (e.key === "c") {
        document.querySelector<HTMLTextAreaElement>("[data-testid=comment-input]")?.focus();
        e.preventDefault();
      } else if (e.key === "?") {
        setShowKeys((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, goNextUnreviewed, walkTo, updateStatus]);

  const handleMouseDown = useCallback(() => {
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
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

  return (
    <div
      style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}
    >
      <div ref={containerRef} style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <div style={{ flex: splitRatio, overflow: "hidden", height: "100%" }}>
          <PlanView sessionId={sessionId} currentNodeId={currentNodeId} onSelectNode={walkTo} />
        </div>

        <Divider onMouseDown={handleMouseDown} />

        <div
          style={{
            flex: 1 - splitRatio,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            background: "var(--ink)",
            borderLeft: "1px solid var(--line)",
          }}
        >
          {currentNode ? (
            <>
              <div style={{ flex: 1, overflow: "auto", padding: "12px 14px" }}>
                {walkPath.length > 0 && (
                  <div
                    data-testid="breadcrumb"
                    style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 10, fontSize: 13, color: "var(--dim)" }}
                  >
                    {walkPath.map((id, i) => (
                      <button
                        key={`${id}-${i}`}
                        onClick={() => jumpToBreadcrumb(i)}
                        style={{ background: "none", border: "none", color: "var(--accent, #4fd6ff)", cursor: "pointer", padding: 0, fontSize: 13, fontFamily: "var(--mono)" }}
                      >
                        {nodeLabel(id)} ›
                      </button>
                    ))}
                    <span style={{ fontFamily: "var(--mono)" }}>{currentNode.label}</span>
                    <button data-testid="return-to-walk" className="btn" style={{ marginLeft: "auto" }} onClick={() => jumpToBreadcrumb(0)}>
                      ⏎ Return to review walk
                    </button>
                  </div>
                )}
                <DiffView node={currentNode} diff={nodeData?.diff} />
                <RelationsPanel
                  callers={nodeData?.callers ?? []}
                  callees={nodeData?.callees ?? []}
                  walkStableIds={walkStableIds}
                  onSelect={selectRelation}
                />
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 10,
                  padding: "12px 16px",
                  borderTop: "1px solid var(--line)",
                  background: "var(--panel)",
                }}
              >
                <button
                  className="btn btn--clean btn--lg"
                  onClick={() =>
                    updateStatus.mutate({
                      nodeId: currentNode.id,
                      reviewStatus: "reviewed-clean",
                    })
                  }
                >
                  ✓ Mark reviewed
                </button>
                <button className="btn btn--lg" data-testid="next-unreviewed" onClick={goNextUnreviewed}>
                  Next unreviewed →
                </button>
              </div>
              <CommentBox sessionId={sessionId} nodeId={currentNode.id} />
            </>
          ) : (
            <EmptyState />
          )}
        </div>
      </div>
      {showKeys && (
        <div className="keys-overlay" onClick={() => setShowKeys(false)}>
          <dl>
            <dt>j / k</dt><dd>next / previous change</dd>
            <dt>n</dt><dd>next unreviewed</dd>
            <dt>r</dt><dd>mark reviewed &amp; advance</dd>
            <dt>c</dt><dd>comment</dd>
            <dt>?</dt><dd>toggle this overlay</dd>
          </dl>
        </div>
      )}
    </div>
  );
}

function Divider({ onMouseDown }: { onMouseDown: () => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
      style={{
        width: 9,
        flexShrink: 0,
        cursor: "col-resize",
        display: "grid",
        placeItems: "center",
        background: "var(--ink)",
      }}
    >
      <div
        style={{
          width: 2,
          height: 34,
          borderRadius: 2,
          background: "var(--line-bright)",
        }}
      />
    </div>
  );
}

function EmptyState() {
  return (
    <div
      style={{
        flex: 1,
        display: "grid",
        placeItems: "center",
        padding: 24,
        textAlign: "center",
      }}
    >
      <div style={{ maxWidth: 280 }}>
        <div style={{ fontSize: 28, marginBottom: 12, opacity: 0.5 }}>⌖</div>
        <h2 style={{ fontSize: 17, marginBottom: 6 }}>Pick a node to start the walk</h2>
        <p style={{ color: "var(--dim)", fontSize: 15, lineHeight: 1.6, margin: 0 }}>
          Pick a unit&apos;s node to read its diff and leave a comment.
        </p>
      </div>
    </div>
  );
}
