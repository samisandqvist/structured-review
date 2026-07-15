import { useState } from "react";
import type { ReactNode } from "react";
import type { Node } from "../api/client.js";
import { NodeBadge } from "./NodeBadge.js";

/**
 * Collapsible local-structure panel under the diff: who calls this node, what
 * it calls, with change/test/walk/review state — bottom-up movement as a local
 * action without a graph view.
 */
export function RelationsPanel({
  callers, callees, walkStableIds, onSelect,
}: {
  callers: Node[];
  callees: Node[];
  walkStableIds: Set<string>;
  onSelect: (nodeId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const rows = [
    ...callers.map((node) => ({ node, direction: "caller" as const })),
    ...callees.map((node) => ({ node, direction: "callee" as const })),
  ];
  if (rows.length === 0) return null;

  return (
    <section data-testid="relations-panel" style={{ marginTop: 14 }}>
      <button
        data-testid="relations-toggle"
        onClick={() => setOpen((v) => !v)}
        style={{ background: "none", border: "none", color: "var(--dim)", cursor: "pointer", padding: 0, fontSize: 14, letterSpacing: "0.05em" }}
      >
        {open ? "▾" : "▸"} RELATIONS · {callers.length} caller{callers.length === 1 ? "" : "s"} · {callees.length} callee{callees.length === 1 ? "" : "s"}
      </button>
      {open && (
        <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          {rows.map(({ node, direction }) => (
            <li key={`${direction}-${node.id}`}>
              <button
                data-testid={`relation-${node.id}`}
                onClick={() => onSelect(node.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                  background: "var(--surface)", border: "1px solid var(--line)",
                  borderRadius: "var(--radius-sm)", padding: "6px 10px", cursor: "pointer",
                  color: "var(--text)", fontSize: 15,
                }}
              >
                <span title={direction === "caller" ? "called by" : "calls"} style={{ color: "var(--dim)", fontFamily: "var(--mono)" }}>
                  {direction === "caller" ? "←" : "→"}
                </span>
                <span style={{ fontFamily: "var(--mono)", fontWeight: 600 }}>{node.label}</span>
                <span style={{ color: "var(--dim)", fontSize: 13 }}>{node.file}:{node.startLine}</span>
                {node.isTest && <Chip>test</Chip>}
                <Chip>{node.changeStatus}</Chip>
                {walkStableIds.has(node.stableId) && <Chip>in walk</Chip>}
                <span style={{ marginLeft: "auto" }}><NodeBadge status={node.reviewStatus} /></span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontSize: 12, color: "var(--dim)", border: "1px solid var(--line-bright)", borderRadius: 4, padding: "0 5px", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}
