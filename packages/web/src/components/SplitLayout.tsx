import { useRef, useCallback } from "react";
import { useUIStore } from "../store/ui.js";
import { useNode, useUpdateNodeStatus } from "../api/hooks.js";
import { GraphView } from "./GraphView.js";
import { DiffView } from "./DiffView.js";
import { CommentBox } from "./CommentBox.js";

export function SplitLayout({ sessionId, currentNodeId }: {
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
    const onMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setSplitRatio((e.clientX - rect.left) / rect.width);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [setSplitRatio]);

  const currentNode = nodeData?.node;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div ref={containerRef} style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <div style={{ flex: splitRatio, overflow: "hidden", height: "100%" }}>
          <GraphView sessionId={sessionId} currentNodeId={currentNodeId} onSelectNode={setCurrentNode} />
        </div>
        <div onMouseDown={handleMouseDown} style={{ width: "4px", cursor: "col-resize", background: "#333", flexShrink: 0 }} />
        <div style={{ flex: 1 - splitRatio, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {currentNode ? (
            <>
              <div style={{ flex: 1, overflow: "auto", padding: "8px" }}>
                <DiffView node={currentNode} />
              </div>
              <div style={{ display: "flex", gap: "4px", padding: "4px 8px", borderTop: "1px solid #333" }}>
                <button onClick={() => updateStatus.mutate({ nodeId: currentNode.id, reviewStatus: "reviewed-clean" })}>✓ Mark reviewed</button>
                <button onClick={() => updateStatus.mutate({ nodeId: currentNode.id, reviewStatus: "reviewed-commented" })}>✎ Mark commented</button>
              </div>
              <CommentBox sessionId={sessionId} nodeId={currentNode.id} />
            </>
          ) : (
            <div style={{ padding: "16px" }}>Select a node to begin</div>
          )}
        </div>
      </div>
    </div>
  );
}
