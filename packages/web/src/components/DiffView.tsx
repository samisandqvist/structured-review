import type { CSSProperties } from "react";
import { useEffect } from "react";
import type { AnchorSide, CommentAnchor, DiffLine, Node, NodeDiff } from "../api/client.js";
import { useUIStore } from "../store/ui.js";
import { NodeBadge } from "./NodeBadge.js";

/** Side+line of a changed row; null for context rows. */
function endpointOf(l: DiffLine): { line: number; side: AnchorSide } | null {
  if (l.type === "added" && l.newLine !== null) return { line: l.newLine, side: "new" };
  if (l.type === "removed" && l.oldLine !== null) return { line: l.oldLine, side: "old" };
  return null;
}

export function anchorFor(lines: DiffLine[], startIdx: number, endIdx: number): CommentAnchor | null {
  const s = lines[startIdx] && endpointOf(lines[startIdx]);
  const e = lines[endIdx] && endpointOf(lines[endIdx]);
  if (!s || !e) return null;
  return { startLine: s.line, startSide: s.side, endLine: e.line, endSide: e.side };
}

export function selectionLabel(anchor: CommentAnchor): string {
  const fmt = (line: number, side: AnchorSide) => `${side === "old" ? "-" : "+"}${line}`;
  const start = fmt(anchor.startLine, anchor.startSide);
  const end = fmt(anchor.endLine, anchor.endSide);
  return start === end && anchor.startSide === anchor.endSide ? `line ${start}` : `lines ${start}…${end}`;
}

/** Client twin of the server's anchorRowRange — same resolution semantics. */
export function resolveAnchorRows(
  lines: DiffLine[],
  anchor: CommentAnchor
): { startIdx: number; endIdx: number } | null {
  const find = (line: number, side: AnchorSide) =>
    lines.findIndex((l) =>
      side === "new" ? l.type === "added" && l.newLine === line : l.type === "removed" && l.oldLine === line
    );
  const startIdx = find(anchor.startLine, anchor.startSide);
  const endIdx = find(anchor.endLine, anchor.endSide);
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) return null;
  return { startIdx, endIdx };
}

const ROW_BG: Record<DiffLine["type"], string> = {
  context: "transparent",
  added: "rgba(70, 211, 138, 0.13)",
  removed: "rgba(248, 90, 90, 0.13)",
};
const TEXT_COLOR: Record<DiffLine["type"], string> = {
  context: "#e8ecf4",
  added: "#cfeede",
  removed: "#f4cfcb",
};
const MARKER: Record<DiffLine["type"], string> = { context: " ", added: "+", removed: "-" };

const gutterStyle: CSSProperties = {
  width: 1, minWidth: 44, padding: "0 8px", textAlign: "right",
  color: "#5c6678", background: "#0f141e", userSelect: "none",
  fontSize: 15, verticalAlign: "top",
};

/** Insert "gap" markers where consecutive lines skip file positions (hunk boundaries). */
function withSeparators(lines: DiffLine[]): ({ line: DiffLine; idx: number } | "gap")[] {
  const out: ({ line: DiffLine; idx: number } | "gap")[] = [];
  let lastOld: number | null = null;
  let lastNew: number | null = null;
  lines.forEach((l, idx) => {
    const oldGap = l.oldLine !== null && lastOld !== null && l.oldLine > lastOld + 1;
    const newGap = l.newLine !== null && lastNew !== null && l.newLine > lastNew + 1;
    if (out.length > 0 && (oldGap || newGap)) out.push("gap");
    out.push({ line: l, idx });
    if (l.oldLine !== null) lastOld = l.oldLine;
    if (l.newLine !== null) lastNew = l.newLine;
  });
  return out;
}

function DiffLines({ lines }: { lines: DiffLine[] }) {
  const lineSelection = useUIStore((s) => s.lineSelection);
  const setLineSelection = useUIStore((s) => s.setLineSelection);

  const handleClick = (idx: number, shiftKey: boolean) => {
    if (!endpointOf(lines[idx])) return; // context rows are inert
    if (lineSelection && shiftKey) {
      const startIdx = Math.min(lineSelection.startIdx, idx);
      const endIdx = Math.max(lineSelection.endIdx, idx);
      const anchor = anchorFor(lines, startIdx, endIdx);
      if (anchor) setLineSelection({ startIdx, endIdx, anchor, label: selectionLabel(anchor) });
      return;
    }
    if (lineSelection && lineSelection.startIdx === idx && lineSelection.endIdx === idx) {
      setLineSelection(null); // toggle off
      return;
    }
    const anchor = anchorFor(lines, idx, idx);
    if (anchor) setLineSelection({ startIdx: idx, endIdx: idx, anchor, label: selectionLabel(anchor) });
  };

  const isSelected = (idx: number) =>
    !!lineSelection && idx >= lineSelection.startIdx && idx <= lineSelection.endIdx;

  return (
    <div style={{ border: "1px solid #283143", borderRadius: 8, overflow: "hidden", background: "#11151f" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--mono)", fontSize: 17, lineHeight: 1.5 }}>
        <tbody>
          {withSeparators(lines).map((entry, i) =>
            entry === "gap" ? (
              <tr key={`gap-${i}`} data-testid="diff-gap">
                <td colSpan={4} style={{ padding: "2px 10px", color: "#5c6678", background: "#161c28", fontSize: 14, textAlign: "center" }}>⋯</td>
              </tr>
            ) : (
              <tr
                key={entry.idx}
                data-line-type={entry.line.type}
                data-selected={isSelected(entry.idx) ? "true" : undefined}
                onClick={(e) => handleClick(entry.idx, e.shiftKey)}
                style={{
                  background: isSelected(entry.idx) ? "rgba(96, 165, 250, 0.16)" : ROW_BG[entry.line.type],
                  boxShadow: isSelected(entry.idx) ? "inset 2px 0 0 #60a5fa" : undefined,
                  cursor: entry.line.type !== "context" ? "pointer" : undefined,
                }}
              >
                <td style={gutterStyle}>{entry.line.oldLine ?? ""}</td>
                <td style={gutterStyle}>{entry.line.newLine ?? ""}</td>
                <td style={{ width: 1, padding: "0 4px", color: TEXT_COLOR[entry.line.type], userSelect: "none" }}>{MARKER[entry.line.type]}</td>
                <td style={{ padding: "0 10px", whiteSpace: "pre-wrap", wordBreak: "break-all", color: TEXT_COLOR[entry.line.type] }}>{entry.line.text}</td>
              </tr>
            )
          )}
        </tbody>
      </table>
    </div>
  );
}

export function DiffView({ node, diff }: { node: Node; diff?: NodeDiff }) {
  const lines = diff?.lines ?? [];
  const pending = useUIStore((s) => s.pendingAnchorHighlight);
  const setLineSelection = useUIStore((s) => s.setLineSelection);
  const clearAnchorHighlight = useUIStore((s) => s.clearAnchorHighlight);

  useEffect(() => {
    if (!pending || lines.length === 0) return;
    const rows = resolveAnchorRows(lines, pending);
    if (rows) {
      setLineSelection({ ...rows, anchor: pending, label: selectionLabel(pending) });
    }
    clearAnchorHighlight(); // resolved or not: the request is consumed (stale anchors no-op)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, lines]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          paddingBottom: 11,
          flexWrap: "wrap",
        }}
      >
        <h2 style={{ fontSize: 19, fontFamily: "var(--mono)", fontWeight: 700 }}>
          {node.label}
        </h2>
        <NodeBadge status={node.reviewStatus} />
        {node.changeStatus === "unchanged" && (
          <span
            style={{
              fontSize: 15,
              color: "var(--dim)",
              border: "1px dashed var(--line-bright)",
              borderRadius: 4,
              padding: "1px 6px",
              letterSpacing: "0.04em",
            }}
          >
            context · unchanged
          </span>
        )}
        <span style={{ fontSize: 15, color: "var(--dim)", marginLeft: "auto" }}>
          {node.file}:{node.startLine}–{node.endLine}
        </span>
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {lines.length > 0 ? (
          <DiffLines lines={lines} />
        ) : (
          <div style={{ padding: 16, color: "var(--faint)", fontSize: 15 }}>
            No source available for this node.
          </div>
        )}
      </div>
    </div>
  );
}
