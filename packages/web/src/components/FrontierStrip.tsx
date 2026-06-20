interface StripNode {
  id: string; label: string;
  reviewStatus: "unreviewed" | "reviewed-clean" | "reviewed-commented" | "reviewed-elsewhere";
  changeStatus: "changed" | "unchanged";
}

export function FrontierStrip({ nodes, currentNodeId, onSelectNode }: {
  nodes: StripNode[];
  currentNodeId: string | null;
  onSelectNode: (id: string) => void;
}) {
  return (
    <div style={{ display: "flex", gap: "4px", padding: "4px 8px", borderTop: "1px solid #333", overflowX: "auto" }}>
      {nodes.map((n) => {
        const isCurrent = n.id === currentNodeId;
        const isReviewed = n.reviewStatus !== "unreviewed";
        return (
          <button key={n.id} onClick={() => onSelectNode(n.id)} style={{
            padding: "2px 8px", border: "1px solid #555",
            background: isCurrent ? "#4a9aef" : "transparent",
            color: isReviewed ? "#888" : "#fff",
            fontWeight: isCurrent ? "bold" : "normal",
            cursor: "pointer", fontSize: "0.8rem",
            opacity: n.changeStatus === "unchanged" ? 0.6 : 1,
          }}><span>{n.label}</span></button>
        );
      })}
    </div>
  );
}
