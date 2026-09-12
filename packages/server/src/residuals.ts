import { basename } from "node:path";
import { changedFilesStrict, fileChangedRanges, subtractRanges, type LineRange } from "./diff.js";
import type { ResidualKind } from "./types.js";
import { isTestFile } from "./util.js";

export interface ResidualNode {
  stableId: string;
  label: string;
  file: string;
  startLine: number;
  endLine: number;
  isTest: boolean;
  ranges: LineRange[];
  kind: ResidualKind;
}

/**
 * Diff hunks not covered by any stored node's span, folded to one pseudo-node
 * per file (bounding box). Guarantees changed lines outside the graph — types,
 * imports, configs, non-indexed files — still enter the review universe.
 */
export function computeResiduals(baseRef: string, nodeSpans: Map<string, LineRange[]>, root: string): ResidualNode[] {
  const out: ResidualNode[] = [];
  for (const file of changedFilesStrict(baseRef, root)) {
    const ranges = fileChangedRanges(baseRef, file, root, { strict: true });
    if (!ranges || ranges.length === 0) continue;
    const spans = nodeSpans.get(file) ?? [];
    const residual = subtractRanges(ranges, spans);
    if (residual.length === 0) continue;
    const start = Math.min(...residual.map((r) => r.start));
    const end = Math.max(...residual.map((r) => r.end));
    const deleted = end === 0; // pure deletion: hunks attribute to new line 0
    // The kind travels as structured data, not a label suffix — the UI decides
    // how to communicate "not reachable through the call graph".
    const kind: ResidualKind = deleted ? "deleted" : spans.length > 0 ? "module-scope" : "whole-file";
    const sorted = residual.slice().sort((a, b) => a.start - b.start);
    out.push({
      stableId: `file-residual:${file}`,
      label: basename(file),
      file,
      startLine: start,
      endLine: end,
      isTest: isTestFile(file),
      ranges: sorted,
      kind,
    });
  }
  return out;
}
