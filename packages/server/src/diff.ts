import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Real diff content for a node, pulled from git.
 *
 * The hub owns the git relationship (the UI never touches git). For a changed
 * node we extract the diff hunks of its file that fall within the node's line
 * span and reconstruct the before/after text for those hunks; the diff viewer
 * re-diffs them for display. For unchanged/context nodes there is no diff, so
 * we return the current source on both sides.
 */
export interface NodeDiff {
  oldText: string;
  newText: string;
}

interface Hunk {
  newStart: number;
  newCount: number;
  lines: string[]; // raw diff lines incl. leading ' ', '+', '-'
}

let cachedRoot: string | undefined;
export function repoRoot(): string {
  if (cachedRoot) return cachedRoot;
  cachedRoot =
    process.env.CRG_REPO_ROOT ??
    (() => {
      try {
        return execFileSync("git", ["rev-parse", "--show-toplevel"], {
          encoding: "utf8",
        }).trim();
      } catch {
        return process.cwd();
      }
    })();
  return cachedRoot;
}

export function getNodeDiff(
  baseRef: string,
  file: string,
  startLine: number,
  endLine: number,
  changeStatus: "changed" | "unchanged",
  root: string = repoRoot()
): NodeDiff {
  if (changeStatus === "unchanged") {
    const slice = readSlice(root, file, startLine, endLine);
    return { oldText: slice, newText: slice };
  }

  let raw: string;
  try {
    // --text: force a textual diff even if git's heuristic flags the blob binary.
    raw = execFileSync("git", ["diff", "--text", "--unified=3", baseRef, "--", file], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    const slice = readSlice(root, file, startLine, endLine);
    return { oldText: slice, newText: slice };
  }

  // Changed file, but maybe no hunk inside this node's span (e.g. the change was
  // in a sibling). Then show the current source unchanged, not a misleading diff.
  return extractHunkDiff(raw, startLine, endLine) ?? sliceBoth(root, file, startLine, endLine);
}

/**
 * Reconstruct before/after text from a file's unified diff, limited to the
 * hunks overlapping [startLine, endLine] (new-file line numbers). Returns null
 * if no hunk touches the span. Pure — exported for testing.
 */
export function extractHunkDiff(rawDiff: string, startLine: number, endLine: number): NodeDiff | null {
  const hunks = parseHunks(rawDiff).filter((h) =>
    overlaps(h.newStart, h.newStart + Math.max(h.newCount, 1) - 1, startLine, endLine)
  );
  if (hunks.length === 0) return null;

  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const h of hunks) {
    for (const line of h.lines) {
      const marker = line[0];
      const text = line.slice(1);
      if (marker === "-") oldLines.push(text);
      else if (marker === "+") newLines.push(text);
      else {
        oldLines.push(text);
        newLines.push(text);
      }
    }
  }
  return { oldText: oldLines.join("\n"), newText: newLines.join("\n") };
}

function sliceBoth(root: string, file: string, startLine: number, endLine: number): NodeDiff {
  const slice = readSlice(root, file, startLine, endLine);
  return { oldText: slice, newText: slice };
}

function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const line of diff.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      current = { newStart: Number(header[1]), newCount: Number(header[2] ?? "1"), lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue; // skip the diff --git / index / ---/+++ preamble
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line[0] === " " || line[0] === "+" || line[0] === "-") current.lines.push(line);
  }
  return hunks;
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

function readSlice(root: string, file: string, startLine: number, endLine: number): string {
  try {
    const content = readFileSync(join(root, file), "utf8");
    const lines = content.split("\n");
    return lines.slice(Math.max(0, startLine - 1), endLine).join("\n");
  } catch {
    return "";
  }
}
