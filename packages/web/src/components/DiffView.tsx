import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { api, type AnchorSide, type CommentAnchor, type DiffLine, type Node, type NodeDiff } from "../api/client.js";
import { useUIStore } from "../store/ui.js";
import { RESIDUAL_KIND } from "../residual-kind.js";
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

export interface GapInfo {
  /** Hidden new-file range; hiddenEnd < hiddenStart = old-side-only gap (pure deletion), not expandable. */
  hiddenStart: number;
  hiddenEnd: number;
}
type DiffRow = { line: DiffLine; idx: number } | { gap: GapInfo };

/** The new-file position each row sits at: its own newLine, or (for removed
 *  lines) the next row's — matching how the server attributes removed lines. */
function effectiveNewPositions(lines: DiffLine[]): number[] {
  const eff = new Array<number>(lines.length);
  let next = Number.MAX_SAFE_INTEGER;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].newLine !== null) next = lines[i].newLine!;
    eff[i] = next;
  }
  return eff;
}

/** Insert gap markers (with their hidden new-file range) where consecutive
 *  lines skip file positions (hunk boundaries). Exported for tests. */
export function withSeparators(lines: DiffLine[]): DiffRow[] {
  const eff = effectiveNewPositions(lines);
  const out: DiffRow[] = [];
  let lastOld: number | null = null;
  let lastNew: number | null = null;
  lines.forEach((l, idx) => {
    const oldGap = l.oldLine !== null && lastOld !== null && l.oldLine > lastOld + 1;
    const newGap = l.newLine !== null && lastNew !== null && l.newLine > lastNew + 1;
    if (out.length > 0 && (oldGap || newGap)) {
      out.push({ gap: { hiddenStart: (lastNew ?? 0) + 1, hiddenEnd: eff[idx] - 1 } });
    }
    out.push({ line: l, idx });
    if (l.oldLine !== null) lastOld = l.oldLine;
    if (l.newLine !== null) lastNew = l.newLine;
  });
  return out;
}

/** Splice expansion blocks (fetched context, tagged expanded) into the shown
 *  lines by new-file position. Blocks never overlap shown lines — they are
 *  requested from gap ranges only. Exported for tests. */
export function mergeExpanded(lines: DiffLine[], blocks: { start: number; lines: DiffLine[] }[]): DiffLine[] {
  if (blocks.length === 0) return lines;
  const merged = lines.slice();
  for (const block of [...blocks].sort((a, b) => a.start - b.start)) {
    const eff = effectiveNewPositions(merged);
    let at = merged.length;
    for (let i = 0; i < merged.length; i++) {
      if (eff[i] > block.start) { at = i; break; }
    }
    merged.splice(at, 0, ...block.lines);
  }
  return merged;
}

/** How many lines one expander click reveals; "all" is offered below this ×25. */
const EXPAND_CHUNK = 20;
const EXPAND_ALL_MAX = 500;

function GapRow({ gap, onExpand }: { gap: GapInfo; onExpand: (start: number, end: number) => void }) {
  const size = gap.hiddenEnd - gap.hiddenStart + 1;
  const btn: CSSProperties = {
    background: "none", border: "none", color: "var(--trace)", cursor: "pointer",
    fontSize: 13, padding: "0 8px", fontFamily: "var(--mono)",
  };
  return (
    <tr data-testid="diff-gap">
      <td colSpan={4} style={{ padding: "2px 10px", color: "#5c6678", background: "#161c28", fontSize: 14, textAlign: "center" }}>
        {size <= 0 ? (
          "⋯"
        ) : size <= EXPAND_CHUNK ? (
          <button style={btn} data-testid="expand-all" onClick={() => onExpand(gap.hiddenStart, gap.hiddenEnd)}>
            ⋯ expand {size} line{size === 1 ? "" : "s"}
          </button>
        ) : (
          <>
            <button style={btn} data-testid="expand-down" title="Reveal lines below the code above"
              onClick={() => onExpand(gap.hiddenStart, gap.hiddenStart + EXPAND_CHUNK - 1)}>
              ↓ {EXPAND_CHUNK}
            </button>
            <span style={{ opacity: 0.6 }}>{size} hidden</span>
            {size <= EXPAND_ALL_MAX && (
              <button style={btn} data-testid="expand-all" onClick={() => onExpand(gap.hiddenStart, gap.hiddenEnd)}>
                all
              </button>
            )}
            <button style={btn} data-testid="expand-up" title="Reveal lines above the code below"
              onClick={() => onExpand(gap.hiddenEnd - EXPAND_CHUNK + 1, gap.hiddenEnd)}>
              ↑ {EXPAND_CHUNK}
            </button>
          </>
        )}
      </td>
    </tr>
  );
}

function DiffLines({ lines, onExpand, edges }: {
  lines: DiffLine[];
  onExpand?: (start: number, end: number) => void;
  edges?: { top: GapInfo | null; bottom: GapInfo | null };
}) {
  const lineSelection = useUIStore((s) => s.lineSelection);
  const setLineSelection = useUIStore((s) => s.setLineSelection);

  const handleClick = (idx: number, shiftKey: boolean) => {
    if (lines[idx].expanded) return; // expanded context is outside this node's diff — not anchorable
    if (!endpointOf(lines[idx])) return; // context rows are inert
    if (lineSelection && shiftKey) {
      const startIdx = Math.min(lineSelection.startIdx, idx);
      const endIdx = Math.max(lineSelection.endIdx, idx);
      const anchor = anchorFor(lines, startIdx, endIdx);
      if (anchor) setLineSelection({ startIdx, endIdx, anchor, label: selectionLabel(anchor) });
      return;
    }
    // No toggle-off on re-click: a silent clear made the "commenting on…"
    // chip vanish while writing a comment. Deselecting is the chip's ✕ only.
    const anchor = anchorFor(lines, idx, idx);
    if (anchor) setLineSelection({ startIdx: idx, endIdx: idx, anchor, label: selectionLabel(anchor) });
  };

  const isSelected = (idx: number) =>
    !!lineSelection && idx >= lineSelection.startIdx && idx <= lineSelection.endIdx;

  const expand = onExpand ?? (() => undefined);
  return (
    <div style={{ border: "1px solid #283143", borderRadius: 8, overflow: "hidden", background: "#11151f" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--mono)", fontSize: 17, lineHeight: 1.5 }}>
        <tbody>
          {edges?.top && <GapRow gap={edges.top} onExpand={expand} />}
          {withSeparators(lines).map((entry, i) =>
            "gap" in entry ? (
              <GapRow key={`gap-${i}`} gap={entry.gap} onExpand={expand} />
            ) : (
              <tr
                key={entry.idx}
                data-line-type={entry.line.type}
                data-expanded={entry.line.expanded ? "true" : undefined}
                data-selected={isSelected(entry.idx) ? "true" : undefined}
                onClick={(e) => handleClick(entry.idx, e.shiftKey)}
                style={{
                  background: isSelected(entry.idx) ? "rgba(96, 165, 250, 0.16)" : ROW_BG[entry.line.type],
                  boxShadow: isSelected(entry.idx) ? "inset 2px 0 0 #60a5fa" : undefined,
                  cursor: entry.line.type !== "context" && !entry.line.expanded ? "pointer" : undefined,
                  opacity: entry.line.expanded ? 0.75 : undefined,
                }}
              >
                <td style={gutterStyle}>{entry.line.oldLine ?? ""}</td>
                <td style={gutterStyle}>{entry.line.newLine ?? ""}</td>
                <td style={{ width: 1, padding: "0 4px", color: TEXT_COLOR[entry.line.type], userSelect: "none" }}>{MARKER[entry.line.type]}</td>
                <td style={{ padding: "0 10px", whiteSpace: "pre-wrap", wordBreak: "break-all", color: TEXT_COLOR[entry.line.type] }}>{entry.line.text}</td>
              </tr>
            )
          )}
          {edges?.bottom && <GapRow gap={edges.bottom} onExpand={expand} />}
        </tbody>
      </table>
    </div>
  );
}

export function DiffView({ node, diff }: { node: Node; diff?: NodeDiff }) {
  const baseLines = diff?.lines ?? [];
  const pending = useUIStore((s) => s.pendingAnchorHighlight);
  const setLineSelection = useUIStore((s) => s.setLineSelection);
  const clearAnchorHighlight = useUIStore((s) => s.clearAnchorHighlight);

  // GitHub-style context expansion: revealed blocks live client-side, keyed by
  // their new-file start, and reset when the node changes.
  const [blocks, setBlocks] = useState<{ start: number; lines: DiffLine[] }[]>([]);
  const [bottomEof, setBottomEof] = useState(false);
  useEffect(() => { setBlocks([]); setBottomEof(false); }, [node.id]);
  const lines = useMemo(() => mergeExpanded(baseLines, blocks), [baseLines, blocks]);

  // Edge expanders: above the first shown line (bounded — we know the range)
  // and below the last (unbounded — EOF discovered by a short/empty fetch).
  const firstNew = lines.find((l) => l.newLine !== null)?.newLine ?? null;
  const lastNew = lines.reduce<number>((m, l) => Math.max(m, l.newLine ?? 0), 0);

  const handleExpand = async (start: number, end: number) => {
    const { lines: fetched } = await api.getNodeContext(node.sessionId, node.id, start, end);
    if (start > lastNew) {
      // Bottom-edge request: a short or empty slice means we hit EOF.
      const maxNew = fetched.reduce((m, l) => Math.max(m, l.newLine ?? 0), 0);
      if (fetched.length === 0 || maxNew < end) setBottomEof(true);
    }
    if (fetched.length === 0) return;
    setBlocks((b) => [...b, { start, lines: fetched.map((l) => ({ ...l, expanded: true })) }]);
  };
  const edges = {
    top: firstNew !== null && firstNew > 1 ? { hiddenStart: 1, hiddenEnd: firstNew - 1 } : null,
    bottom: lines.length > 0 && !bottomEof
      ? { hiddenStart: lastNew + 1, hiddenEnd: lastNew + EXPAND_CHUNK }
      : null,
  };

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
        {node.residualKind && (
          <span
            data-testid="residual-badge"
            title={RESIDUAL_KIND[node.residualKind].title}
            style={{
              fontSize: 15,
              color: "var(--dim)",
              border: "1px dotted var(--line-bright)",
              borderRadius: 4,
              padding: "1px 6px",
              letterSpacing: "0.04em",
            }}
          >
            {RESIDUAL_KIND[node.residualKind].badge} · off-graph
          </span>
        )}
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
          <DiffLines lines={lines} onExpand={handleExpand} edges={edges} />
        ) : (
          <div style={{ padding: 16, color: "var(--faint)", fontSize: 15 }}>
            No source available for this node.
          </div>
        )}
      </div>
    </div>
  );
}
