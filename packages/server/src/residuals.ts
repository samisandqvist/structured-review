import { basename } from "node:path";
import { changedFilesStrict, fileChangedRanges, subtractRanges, type LineRange } from "./diff.js";
import { isTestFile } from "./util.js";

export interface ResidualNode {
  stableId: string;
  label: string;
  file: string;
  startLine: number;
  endLine: number;
  isTest: boolean;
}

/**
 * Diff hunks not covered by any stored node's span, folded to one pseudo-node
 * per file (bounding box). Guarantees changed lines outside the graph — types,
 * imports, configs, non-indexed files — still enter the review universe.
 */
export function computeResiduals(
  baseRef: string,
  nodeSpans: Map<string, LineRange[]>,
  root: string
): ResidualNode[] {
  const out: ResidualNode[] = [];
  for (const file of changedFilesStrict(baseRef, root)) {
    const ranges = fileChangedRanges(baseRef, file, root);
    if (!ranges || ranges.length === 0) continue;
    const spans = nodeSpans.get(file) ?? [];
    const residual = subtractRanges(ranges, spans);
    if (residual.length === 0) continue;
    const start = Math.min(...residual.map((r) => r.start));
    const end = Math.max(...residual.map((r) => r.end));
    const deleted = end === 0; // pure deletion: hunks attribute to new line 0
    const suffix = deleted ? " (deleted)" : spans.length > 0 ? " (module scope)" : "";
    out.push({
      stableId: `file-residual:${file}`,
      label: `${basename(file)}${suffix}`,
      file,
      startLine: start,
      endLine: end,
      isTest: isTestFile(file),
    });
  }
  return out;
}
