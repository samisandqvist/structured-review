import type { Node } from "../api/client.js";

const STATUS_STYLES: Record<Node["reviewStatus"], { bg: string; label: string }> = {
  unreviewed: { bg: "#444", label: "unreviewed" },
  "reviewed-clean": { bg: "#2a7a2a", label: "✓" },
  "reviewed-commented": { bg: "#a73a2a", label: "✎" },
  "reviewed-elsewhere": { bg: "#4a6a9a", label: "✓ (other)" },
};

export function NodeBadge({ status }: { status: Node["reviewStatus"] }) {
  const style = STATUS_STYLES[status];
  return (
    <span style={{ backgroundColor: style.bg, color: "white", fontSize: "0.7rem", padding: "1px 4px", borderRadius: "3px" }}>
      {style.label}
    </span>
  );
}
