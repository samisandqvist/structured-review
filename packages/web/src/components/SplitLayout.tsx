import { useRef, useCallback } from "react";
import { useUIStore } from "../store/ui.js";
import { GraphView } from "./GraphView.js";

export function SplitLayout({ sessionId, currentNodeId }: {
  sessionId: string;
  currentNodeId: string | null;
}) {
  const splitRatio = useUIStore((s) => s.splitRatio);
  const setSplitRatio = useUIStore((s) => s.setSplitRatio);
  const setCurrentNode = useUIStore((s) => s.setCurrentNode);
  const containerRef = useRef<HTMLDivElement>(null);

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

  return (
    <div ref={containerRef} style={{ flex: 1, display: "flex", overflow: "hidden" }}>
      <div style={{ flex: splitRatio, overflow: "hidden" }}>
        <GraphView sessionId={sessionId} currentNodeId={currentNodeId} onSelectNode={setCurrentNode} />
      </div>
      <div onMouseDown={handleMouseDown} style={{ width: "4px", cursor: "col-resize", background: "#333", flexShrink: 0 }} />
      <div style={{ flex: 1 - splitRatio, padding: "8px", overflow: "auto" }}>Diff view</div>
    </div>
  );
}
