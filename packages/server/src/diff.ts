import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnchorSide, CommentAnchor, LineRange } from "./types.js";
export type { AnchorSide, CommentAnchor, LineRange };

/**
 * Real diff content for a node, pulled from git.
 *
 * The hub owns the git relationship (the UI never touches git). For a changed
 * node we extract the diff hunks of its file that fall within the node's line
 * span and reconstruct the before/after text for those hunks; the diff viewer
 * re-diffs them for display. For unchanged/context nodes there is no diff, so
 * we return the current source on both sides.
 */
export interface DiffLine {
  type: "context" | "added" | "removed";
  /** Real old-file line number (null for added lines). */
  oldLine: number | null;
  /** Real new-file line number (null for removed lines). */
  newLine: number | null;
  text: string;
}

export interface NodeDiff {
  oldText: string;
  newText: string;
  lines: DiffLine[];
}

interface Hunk {
  oldStart: number;
  newStart: number;
  newCount: number;
  lines: string[]; // raw diff lines incl. leading ' ', '+', '-'
}

export class GitError extends Error {
  constructor(readonly phase: "resolve-ref" | "list-files" | "read-diff", message: string) {
    super(message);
    this.name = "GitError";
  }
}

// Suppress inherited stderr on execFileSync calls: expected-failure paths
// (bad refs, non-repo dirs) would otherwise flood test/CLI output with raw
// git usage/error text. stdout still comes back as a string via `encoding`.
const QUIET: { stdio: ["ignore", "pipe", "pipe"] } = { stdio: ["ignore", "pipe", "pipe"] };

/**
 * The new-file line ranges actually touched by `git diff` for a file, or null
 * if there is no diff (or git errored) — meaning "unknown, don't reclassify".
 * Uses --unified=0 so ranges are the changed lines themselves, no context.
 */
export function fileChangedRanges(baseRef: string, file: string, root: string = repoRoot()): LineRange[] | null {
  let raw: string;
  try {
    raw = execFileSync("git", ["diff", "--text", "--unified=0", baseRef, "--", file], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      ...QUIET,
    });
  } catch {
    return null;
  }
  if (!raw.trim()) return null;
  return parseHunks(raw).map((h) => ({
    start: h.newStart,
    // A pure deletion has newCount 0; treat it as touching the line it sits at.
    end: h.newStart + Math.max(h.newCount, 1) - 1,
  }));
}

export function rangesOverlap(ranges: LineRange[], startLine: number, endLine: number): boolean {
  return ranges.some((r) => overlaps(r.start, r.end, startLine, endLine));
}

/** Current HEAD sha, or null when git is unavailable. */
export function gitHeadSha(root: string = repoRoot()): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", ...QUIET }).trim();
  } catch {
    return null;
  }
}

/**
 * Content-sensitive repo state fingerprint, or null when git is unavailable.
 * sha256 over HEAD + `git diff HEAD` (staged + unstaged tracked changes) + each
 * untracked file's path and content — so editing an already-dirty file (which
 * leaves `git status --porcelain` unchanged) still moves the fingerprint.
 */
export function repoFingerprint(root: string = repoRoot()): string | null {
  try {
    const h = createHash("sha256");
    h.update(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", ...QUIET }));
    h.update(execFileSync("git", ["diff", "HEAD"], { cwd: root, maxBuffer: 256 * 1024 * 1024, ...QUIET }));
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", ...QUIET })
      .split("\n").filter(Boolean);
    for (const f of untracked) {
      h.update(f);
      try { h.update(readFileSync(join(root, f))); } catch { h.update("<unreadable>"); }
    }
    return h.digest("hex");
  } catch {
    return null;
  }
}

/**
 * Content-sensitive fingerprint of one subtree (a language root), or null
 * when git is unavailable. Keyed on the subtree's tree object sha at HEAD —
 * not HEAD itself — so commits that don't touch the subtree leave the key
 * unchanged; plus `git diff HEAD -- <subdir>` (staged + unstaged) and each
 * untracked file's path and content under the subtree.
 *
 * Known limitation: the `""` (repo root) subdir key spans the *whole* repo
 * (pathspec "."), so a language root that sits at the repo root above other
 * nested-language roots invalidates on any change anywhere in the tree, not
 * just changes relevant to its own language — see the Phase 1 roadmap
 * checkpoint note for the remedy (language-scoped fingerprint by SOURCE_EXTS).
 */
export function subtreeFingerprint(subdir: string, root: string = repoRoot()): string | null {
  const pathspec = subdir === "" ? "." : subdir;
  try {
    const h = createHash("sha256");
    try {
      const treeRef = subdir === "" ? "HEAD^{tree}" : `HEAD:${subdir}`;
      h.update(execFileSync("git", ["rev-parse", treeRef], { cwd: root, encoding: "utf8", ...QUIET }));
    } catch {
      // Subtree absent at HEAD (brand-new root): untracked contents below cover it.
      h.update("<no-tree>");
    }
    h.update(execFileSync("git", ["diff", "HEAD", "--", pathspec], { cwd: root, maxBuffer: 256 * 1024 * 1024, ...QUIET }));
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", pathspec], { cwd: root, encoding: "utf8", ...QUIET })
      .split("\n").filter(Boolean);
    for (const f of untracked) {
      h.update(f);
      try { h.update(readFileSync(join(root, f))); } catch { h.update("<unreadable>"); }
    }
    return h.digest("hex");
  } catch {
    return null;
  }
}

/** The currently checked-out branch name ("HEAD" when detached), or null on git failure. */
export function currentBranch(root: string = repoRoot()): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8", ...QUIET }).trim();
  } catch {
    return null;
  }
}

/** Repo-relative paths changed vs baseRef ([] on git failure). */
export function changedFiles(baseRef: string, root: string = repoRoot()): string[] {
  try {
    const raw = execFileSync("git", ["diff", "--name-only", baseRef], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      ...QUIET,
    });
    return raw.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Resolves `ref` to a full commit sha, or null if it doesn't exist in `root`. */
export function resolveRef(ref: string, root: string = repoRoot()): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: root, encoding: "utf8", ...QUIET }).trim();
  } catch {
    return null;
  }
}

/**
 * Repo-relative paths changed vs baseRef. Unlike `changedFiles`, git failure
 * throws `GitError` instead of returning `[]` — for callers (session
 * creation) where an empty-but-broken result would be indistinguishable from
 * "genuinely no changes" and silently violate the coverage guarantee.
 */
export function changedFilesStrict(baseRef: string, root: string = repoRoot()): string[] {
  try {
    const raw = execFileSync("git", ["diff", "--name-only", baseRef], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      ...QUIET,
    });
    return raw.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    throw new GitError("list-files", `git diff --name-only ${baseRef} failed: ${(e as Error).message}`);
  }
}

/** Parts of `ranges` not covered by any of `spans`. */
export function subtractRanges(ranges: LineRange[], spans: LineRange[]): LineRange[] {
  const out: LineRange[] = [];
  for (const range of ranges) {
    let pieces: LineRange[] = [range];
    for (const s of spans) {
      const next: LineRange[] = [];
      for (const p of pieces) {
        if (s.end < p.start || s.start > p.end) { next.push(p); continue; }
        if (s.start > p.start) next.push({ start: p.start, end: s.start - 1 });
        if (s.end < p.end) next.push({ start: s.end + 1, end: p.end });
      }
      pieces = next;
    }
    out.push(...pieces);
  }
  return out;
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
          ...QUIET,
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
    return withTexts(contextLines(readSlice(root, file, startLine, endLine), startLine));
  }

  let raw: string;
  try {
    // --text: force a textual diff even if git's heuristic flags the blob binary.
    raw = execFileSync("git", ["diff", "--text", "--unified=3", baseRef, "--", file], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      ...QUIET,
    });
  } catch {
    return withTexts(contextLines(readSlice(root, file, startLine, endLine), startLine));
  }

  // Changed file, but maybe no hunk inside this node's span (e.g. the change was
  // in a sibling). Then show the current source unchanged, not a misleading diff.
  return extractHunkDiff(raw, startLine, endLine) ?? sliceBoth(root, file, startLine, endLine);
}

/**
 * Resolve a comment anchor's endpoints to row indexes in a node's rendered
 * diff. Endpoints must be CHANGED lines — `added` addressed by newLine on
 * side "new", `removed` by oldLine on side "old" — and the range must be
 * ordered by row position. Null = anchor does not resolve (context line,
 * absent line, wrong side, or inverted range).
 */
export function anchorRowRange(
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

/**
 * Reconstruct before/after text from a file's unified diff, clipped to the
 * node's new-file line span [startLine, endLine]. Walking each hunk and tracking
 * the running new-file line number lets us keep only the lines belonging to this
 * node — so two functions inside one big hunk get distinct diffs instead of the
 * whole hunk. Returns null if nothing falls in the span. Pure — exported for tests.
 */
export function extractHunkDiff(rawDiff: string, startLine: number, endLine: number): NodeDiff | null {
  const lines: DiffLine[] = [];
  for (const h of parseHunks(rawDiff)) {
    let oldLine = h.oldStart;
    let newLine = h.newStart;
    for (const line of h.lines) {
      const marker = line[0];
      const text = line.slice(1);
      const inSpan = newLine >= startLine && newLine <= endLine;
      if (marker === " ") {
        if (inSpan) lines.push({ type: "context", oldLine, newLine, text });
        oldLine++;
        newLine++;
      } else if (marker === "+") {
        if (inSpan) lines.push({ type: "added", oldLine: null, newLine, text });
        newLine++;
      } else {
        // Removed line: no new-file line of its own; attribute it to the new
        // position it sits at (the upcoming new line).
        if (inSpan) lines.push({ type: "removed", oldLine, newLine: null, text });
        oldLine++;
      }
    }
  }
  if (lines.length === 0) return null;
  return withTexts(lines);
}

/** DiffLines for several disjoint new-file ranges of one file's unified diff.
 *  Each range is clipped exactly (extractHunkDiff), so hunks inside covered
 *  node spans never leak in. Null when nothing falls in any range. */
export function extractLinesForRanges(rawDiff: string, ranges: LineRange[]): NodeDiff | null {
  const lines: DiffLine[] = [];
  for (const r of ranges) {
    const d = extractHunkDiff(rawDiff, r.start, r.end);
    if (d) lines.push(...d.lines);
  }
  if (lines.length === 0) return null;
  return withTexts(lines);
}

/** Diff for a residual pseudo-node: only its exact residual ranges. */
export function getNodeDiffForRanges(
  baseRef: string,
  file: string,
  ranges: LineRange[],
  root: string = repoRoot()
): NodeDiff | null {
  let raw: string;
  try {
    raw = execFileSync("git", ["diff", "--text", "--unified=3", baseRef, "--", file], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      ...QUIET,
    });
  } catch {
    return null;
  }
  return extractLinesForRanges(raw, ranges);
}

function withTexts(lines: DiffLine[]): NodeDiff {
  return {
    oldText: lines.filter((l) => l.type !== "added").map((l) => l.text).join("\n"),
    newText: lines.filter((l) => l.type !== "removed").map((l) => l.text).join("\n"),
    lines,
  };
}

function contextLines(slice: string, startLine: number): DiffLine[] {
  if (!slice) return [];
  return slice.split("\n").map((text, i) => ({
    type: "context" as const,
    oldLine: startLine + i,
    newLine: startLine + i,
    text,
  }));
}

/** The full unified diff (context 3) of a file vs baseRef, or null if none/errored. */
export function fileUnifiedDiff(baseRef: string, file: string, root: string = repoRoot()): string | null {
  try {
    const raw = execFileSync("git", ["diff", "--text", "--unified=3", baseRef, "--", file], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      ...QUIET,
    });
    return raw.trim() ? raw : null;
  } catch {
    return null;
  }
}

/** Count +/- lines of a unified diff that fall within the new-file span [startLine, endLine]. */
export function nodeChangeStats(rawDiff: string, startLine: number, endLine: number): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of parseHunks(rawDiff)) {
    let newLine = h.newStart;
    for (const line of h.lines) {
      const marker = line[0];
      const inSpan = newLine >= startLine && newLine <= endLine;
      if (marker === "+") {
        if (inSpan) added++;
        newLine++;
      } else if (marker === " ") {
        newLine++;
      } else {
        // '-': no new-file line of its own; attribute to the upcoming new line.
        if (inSpan) removed++;
      }
    }
  }
  return { added, removed };
}

/** The declaration line of a node: first non-blank line at/after startLine. */
export function nodeSignature(file: string, startLine: number, root: string = repoRoot()): string {
  try {
    const lines = readFileSync(join(root, file), "utf8").split("\n");
    for (let i = startLine - 1; i < Math.min(lines.length, startLine + 4); i++) {
      const t = lines[i]?.trim();
      if (t) return t;
    }
  } catch {
    /* fall through */
  }
  return "";
}

/**
 * Bounded, human-readable fragment of a node's diff for comment export:
 * a window from two lines before the first changed line through two after
 * the last (the whole fragment when nothing changed), capped in lines and
 * characters. Format: marker + right-aligned file line number + text.
 */
export function formatHunkSnippet(lines: DiffLine[], maxLines = 40, maxChars = 2000): string {
  if (lines.length === 0) return "";
  const firstChanged = lines.findIndex((l) => l.type !== "context");
  const lastChanged = firstChanged === -1
    ? lines.length - 1
    : lines.length - 1 - [...lines].reverse().findIndex((l) => l.type !== "context");
  const from = Math.max(0, (firstChanged === -1 ? 0 : firstChanged) - 2);
  const to = Math.min(lines.length - 1, lastChanged + 2);
  const window = lines.slice(from, Math.min(to + 1, from + maxLines));
  const out: string[] = [];
  let chars = 0;
  for (const l of window) {
    const s = `${MARKER_CHAR[l.type]}${String(l.newLine ?? l.oldLine ?? 0).padStart(5)} ${l.text}`;
    if (chars + s.length > maxChars) break;
    out.push(s);
    chars += s.length + 1;
  }
  return out.join("\n");
}

const MARKER_CHAR: Record<DiffLine["type"], string> = { context: " ", added: "+", removed: "-" };

function sliceBoth(root: string, file: string, startLine: number, endLine: number): NodeDiff {
  return withTexts(contextLines(readSlice(root, file, startLine, endLine), startLine));
}

function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const line of diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), newCount: Number(header[3] ?? "1"), lines: [] };
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
