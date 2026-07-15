import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractHunkDiff, extractLinesForRanges, getNodeDiff, nodeChangeStats, subtractRanges, resolveRef, changedFilesStrict, currentBranch, repoFingerprint, formatHunkSnippet, GitError } from "../src/diff.js";
import type { DiffLine } from "../src/diff.js";

let fixtureRepo: string;
let emptyTmpDir: string;
beforeAll(() => {
  fixtureRepo = mkdtempSync(join(tmpdir(), "crw-diff-fixture-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: fixtureRepo, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(fixtureRepo, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-m", "init");

  emptyTmpDir = mkdtempSync(join(tmpdir(), "crw-diff-empty-"));
});
afterAll(() => {
  rmSync(fixtureRepo, { recursive: true, force: true });
  rmSync(emptyTmpDir, { recursive: true, force: true });
});

describe("resolveRef", () => {
  it("resolves HEAD and returns null for unknown refs", () => {
    expect(resolveRef("HEAD", fixtureRepo)).toMatch(/^[0-9a-f]{40}$/);
    expect(resolveRef("no-such-ref", fixtureRepo)).toBeNull();
  });
});

describe("changedFilesStrict", () => {
  it("throws GitError outside a repo", () => {
    expect(() => changedFilesStrict("HEAD", emptyTmpDir)).toThrow(GitError);
  });
  it("returns [] for a clean repo", () => {
    expect(changedFilesStrict("HEAD", fixtureRepo)).toEqual([]);
  });
});

describe("currentBranch", () => {
  it("returns the checked-out branch", () => {
    expect(currentBranch(fixtureRepo)).toBe("main"); // fixture created with git init -b main
  });
  it("returns null outside a repo", () => {
    expect(currentBranch(emptyTmpDir)).toBeNull();
  });
});

const RAW = `diff --git a/src/f.ts b/src/f.ts
index abc1234..def5678 100644
--- a/src/f.ts
+++ b/src/f.ts
@@ -10,5 +10,6 @@ function foo() {
 const a = 1;
 const b = 2;
-const c = 3;
+const c = 30;
+const d = 4;
 const e = 5;
`;

describe("extractHunkDiff", () => {
  it("reconstructs before/after for hunks overlapping the node span", () => {
    const diff = extractHunkDiff(RAW, 10, 16)!;
    expect(diff).not.toBeNull();
    expect(diff.oldText).toBe(["const a = 1;", "const b = 2;", "const c = 3;", "const e = 5;"].join("\n"));
    expect(diff.newText).toBe(
      ["const a = 1;", "const b = 2;", "const c = 30;", "const d = 4;", "const e = 5;"].join("\n")
    );
  });

  it("returns null when no hunk touches the node span", () => {
    expect(extractHunkDiff(RAW, 200, 250)).toBeNull();
  });

  it("clips the diff to the node's line span (distinct slices within one hunk)", () => {
    // Only new line 13 (the added `const d = 4;`) is in span.
    const diff = extractHunkDiff(RAW, 13, 13)!;
    expect(diff.newText).toBe("const d = 4;");
    expect(diff.oldText).toBe("");
  });
});

describe("nodeChangeStats", () => {
  const raw = [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -10,2 +10,3 @@",
    " const a = 1;",   // context, new line 10
    "-const b = 2;",   // removed, attributed to new line 11
    "+const b = 3;",   // added, new line 11
    "+const c = 4;",   // added, new line 12
  ].join("\n");

  it("counts +/- lines within the node span", () => {
    expect(nodeChangeStats(raw, 10, 12)).toEqual({ added: 2, removed: 1 });
  });
  it("ignores changes outside the span", () => {
    expect(nodeChangeStats(raw, 10, 10)).toEqual({ added: 0, removed: 0 });
  });
});

describe("repoFingerprint", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "crw-fp-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
    git("init", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git("add", ".");
    git("commit", "-m", "init");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("is stable when nothing changed", () => {
    expect(repoFingerprint(dir)).toBe(repoFingerprint(dir));
  });

  it("changes when an already-dirty file is edited again", () => {
    writeFileSync(join(dir, "a.txt"), "dirty1\n");
    const f1 = repoFingerprint(dir);
    writeFileSync(join(dir, "a.txt"), "dirty2\n"); // porcelain status unchanged: still " M a.txt"
    const f2 = repoFingerprint(dir);
    expect(f2).not.toBe(f1);
  });

  it("changes when an untracked file's content changes", () => {
    writeFileSync(join(dir, "u.txt"), "u1\n");
    const f1 = repoFingerprint(dir);
    writeFileSync(join(dir, "u.txt"), "u2\n");
    const f2 = repoFingerprint(dir);
    expect(f2).not.toBe(f1);
  });

  it("returns null when git is unavailable", () => {
    expect(repoFingerprint(emptyTmpDir)).toBeNull();
  });
});

describe("extractHunkDiff line coordinates", () => {
  const raw = [
    "diff --git a/f.ts b/f.ts",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -10,4 +10,4 @@",
    " line ten",
    "-old eleven",
    "+new eleven",
    " line twelve",
    " line thirteen",
  ].join("\n");

  it("tracks both old and new file line numbers through a hunk", () => {
    const d = extractHunkDiff(raw, 10, 13)!;
    const expected: DiffLine[] = [
      { type: "context", oldLine: 10, newLine: 10, text: "line ten" },
      { type: "removed", oldLine: 11, newLine: null, text: "old eleven" },
      { type: "added", oldLine: null, newLine: 11, text: "new eleven" },
      { type: "context", oldLine: 12, newLine: 12, text: "line twelve" },
      { type: "context", oldLine: 13, newLine: 13, text: "line thirteen" },
    ];
    expect(d.lines).toEqual(expected);
  });

  it("derives oldText/newText from the same lines", () => {
    const d = extractHunkDiff(raw, 10, 13)!;
    expect(d.oldText).toBe("line ten\nold eleven\nline twelve\nline thirteen");
    expect(d.newText).toBe("line ten\nnew eleven\nline twelve\nline thirteen");
  });

  it("tracks old-line drift across earlier hunks", () => {
    // An earlier hunk that adds 2 lines shifts the second hunk's old numbers.
    const twoHunks = [
      "@@ -1,1 +1,3 @@",
      " top",
      "+ins a",
      "+ins b",
      "@@ -20,2 +22,2 @@",
      " ctx",
      "-gone",
      "+here",
    ].join("\n");
    const d = extractHunkDiff(twoHunks, 22, 23)!;
    expect(d.lines).toEqual([
      { type: "context", oldLine: 20, newLine: 22, text: "ctx" },
      { type: "removed", oldLine: 21, newLine: null, text: "gone" },
      { type: "added", oldLine: null, newLine: 23, text: "here" },
    ]);
  });
});

describe("getNodeDiff", () => {
  // No test in this file previously exercised getNodeDiff directly; this
  // covers its "unchanged" branch (a plain readSlice, no git hunk involved)
  // using the fixtureRepo/a.txt ("one\n") set up in beforeAll above.
  it("returns unchanged text with real line numbers for an unchanged node", () => {
    const d = getNodeDiff("HEAD", "a.txt", 1, 1, "unchanged", fixtureRepo);
    expect(d.oldText).toBe(d.newText);
    expect(d.lines[0]).toEqual({ type: "context", oldLine: 1, newLine: 1, text: "one" });
  });
});

describe("formatHunkSnippet", () => {
  const lines = [
    { type: "context" as const, oldLine: 1, newLine: 1, text: "a" },
    { type: "context" as const, oldLine: 2, newLine: 2, text: "b" },
    { type: "context" as const, oldLine: 3, newLine: 3, text: "c" },
    { type: "context" as const, oldLine: 4, newLine: 4, text: "d" },
    { type: "removed" as const, oldLine: 5, newLine: null, text: "old" },
    { type: "added" as const, oldLine: null, newLine: 5, text: "new" },
    { type: "context" as const, oldLine: 6, newLine: 6, text: "e" },
  ];

  it("windows around the changed lines with two context lines", () => {
    expect(formatHunkSnippet(lines).split("\n")).toEqual([
      "     3 c",
      "     4 d",
      "-    5 old",
      "+    5 new",
      "     6 e",
    ]);
  });

  it("caps line count", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      type: "added" as const, oldLine: null, newLine: i + 1, text: `l${i}`,
    }));
    expect(formatHunkSnippet(many, 10).split("\n")).toHaveLength(10);
  });

  it("uses the whole (bounded) fragment when nothing changed", () => {
    const ctx = lines.filter((l) => l.type === "context");
    expect(formatHunkSnippet(ctx).split("\n")).toHaveLength(ctx.length);
  });

  it("returns empty string for no lines", () => {
    expect(formatHunkSnippet([])).toBe("");
  });
});

describe("getNodeDiffForRanges", () => {
  // Synthetic diff: hunk 1 touches lines 2-3 (residual), hunk 2 touches
  // lines 10-12 (covered by a function node), hunk 3 touches lines 40-41 (residual).
  const raw = [
    "diff --git a/f.ts b/f.ts",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -2,2 +2,2 @@",
    "-old two",
    "+new two",
    " ctx three",
    "@@ -10,3 +10,3 @@",
    " fn body a",
    "-fn old",
    "+fn new",
    " fn body b",
    "@@ -40,2 +40,2 @@",
    " ctx forty",
    "-old fortyone",
    "+new fortyone",
  ].join("\n");

  it("includes only the given ranges, excluding covered function hunks", () => {
    // NOTE: this test calls the git-free core; see implementation step — the
    // exported helper extractLinesForRanges is pure, getNodeDiffForRanges shells git.
    const d = extractLinesForRanges(raw, [{ start: 2, end: 3 }, { start: 40, end: 41 }])!;
    const texts = d.lines.map((l) => l.text);
    expect(texts).toContain("new two");
    expect(texts).toContain("new fortyone");
    expect(texts).not.toContain("fn new");
    expect(texts).not.toContain("fn old");
  });

  it("keeps real coordinates so the renderer shows a gap between fragments", () => {
    const d = extractLinesForRanges(raw, [{ start: 2, end: 3 }, { start: 40, end: 41 }])!;
    const newLines = d.lines.map((l) => l.newLine).filter((n): n is number => n !== null);
    expect(Math.max(...newLines) - Math.min(...newLines)).toBeGreaterThan(30);
  });

  it("returns null when no range matches", () => {
    expect(extractLinesForRanges(raw, [{ start: 100, end: 110 }])).toBeNull();
  });
});

describe("subtractRanges", () => {
  const r = (start: number, end: number) => ({ start, end });
  it("returns ranges untouched when spans are disjoint", () => {
    expect(subtractRanges([r(1, 5)], [r(10, 20)])).toEqual([r(1, 5)]);
  });
  it("removes a fully covered range", () => {
    expect(subtractRanges([r(12, 15)], [r(10, 20)])).toEqual([]);
  });
  it("trims overlap at both ends", () => {
    expect(subtractRanges([r(5, 25)], [r(10, 20)])).toEqual([r(5, 9), r(21, 25)]);
  });
  it("subtracts multiple spans from one range", () => {
    expect(subtractRanges([r(1, 30)], [r(5, 10), r(20, 25)])).toEqual([r(1, 4), r(11, 19), r(26, 30)]);
  });
  it("handles multiple input ranges", () => {
    expect(subtractRanges([r(1, 3), r(8, 12)], [r(2, 9)])).toEqual([r(1, 1), r(10, 12)]);
  });
});
