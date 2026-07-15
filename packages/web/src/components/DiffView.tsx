import type { CSSProperties } from "react";
import type { DiffLine, Node, NodeDiff } from "../api/client.js";
import { NodeBadge } from "./NodeBadge.js";

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
  fontSize: 14, verticalAlign: "top",
};

/** Insert "gap" markers where consecutive lines skip file positions (hunk boundaries). */
function withSeparators(lines: DiffLine[]): (DiffLine | "gap")[] {
  const out: (DiffLine | "gap")[] = [];
  let lastOld: number | null = null;
  let lastNew: number | null = null;
  for (const l of lines) {
    const oldGap = l.oldLine !== null && lastOld !== null && l.oldLine > lastOld + 1;
    const newGap = l.newLine !== null && lastNew !== null && l.newLine > lastNew + 1;
    if (out.length > 0 && (oldGap || newGap)) out.push("gap");
    out.push(l);
    if (l.oldLine !== null) lastOld = l.oldLine;
    if (l.newLine !== null) lastNew = l.newLine;
  }
  return out;
}

function DiffLines({ lines }: { lines: DiffLine[] }) {
  return (
    <div style={{ border: "1px solid #283143", borderRadius: 8, overflow: "hidden", background: "#11151f" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--mono)", fontSize: 16, lineHeight: 1.5 }}>
        <tbody>
          {withSeparators(lines).map((l, i) =>
            l === "gap" ? (
              <tr key={`gap-${i}`} data-testid="diff-gap">
                <td colSpan={4} style={{ padding: "2px 10px", color: "#5c6678", background: "#161c28", fontSize: 13, textAlign: "center" }}>⋯</td>
              </tr>
            ) : (
              <tr key={i} data-line-type={l.type} style={{ background: ROW_BG[l.type] }}>
                <td style={gutterStyle}>{l.oldLine ?? ""}</td>
                <td style={gutterStyle}>{l.newLine ?? ""}</td>
                <td style={{ width: 1, padding: "0 4px", color: TEXT_COLOR[l.type], userSelect: "none" }}>{MARKER[l.type]}</td>
                <td style={{ padding: "0 10px", whiteSpace: "pre-wrap", wordBreak: "break-all", color: TEXT_COLOR[l.type] }}>{l.text}</td>
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
        <h2 style={{ fontSize: 18, fontFamily: "var(--mono)", fontWeight: 700 }}>
          {node.label}
        </h2>
        <NodeBadge status={node.reviewStatus} />
        {node.changeStatus === "unchanged" && (
          <span
            style={{
              fontSize: 14,
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
        <span style={{ fontSize: 14, color: "var(--dim)", marginLeft: "auto" }}>
          {node.file}:{node.startLine}–{node.endLine}
        </span>
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {lines.length > 0 ? (
          <DiffLines lines={lines} />
        ) : (
          <div style={{ padding: 16, color: "var(--faint)", fontSize: 14 }}>
            No source available for this node.
          </div>
        )}
      </div>
    </div>
  );
}
