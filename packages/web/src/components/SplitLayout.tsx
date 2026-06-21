import { useRef, useCallback } from "react";
import { useUIStore } from "../store/ui.js";
import { useNode, useUpdateNodeStatus } from "../api/hooks.js";
import { GraphView } from "./GraphView.js";
import { DiffView } from "./DiffView.js";
import { CommentBox } from "./CommentBox.js";

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
          <GraphView
            sessionId={sessionId}
            currentNodeId={currentNodeId}
            onSelectNode={setCurrentNode}
          />
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
                <DiffView node={currentNode} diff={nodeData?.diff} />
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
              </div>
              <CommentBox sessionId={sessionId} nodeId={currentNode.id} />
            </>
          ) : (
            <EmptyState />
          )}
        </div>
      </div>
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
          The graph is the change, laid out by call depth — callers on top,
          callees below. Select any node to read its diff and leave a comment.
        </p>
      </div>
    </div>
  );
}
