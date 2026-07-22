import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractHunkDiff, extractLinesForRanges, expandedContextSlice, getNodeDiff, nodeChangeStats, subtractRanges, resolveRef, changedFilesStrict, currentBranch, repoFingerprint, subtreeFingerprint, formatHunkSnippet, anchorRowRange, GitError } from "../src/diff.js";
import type { DiffLine } from "../src/diff.js";
import type { CommentAnchor } from "../src/types.js";
import { languagePathspecs } from "../src/graph/roots.js";

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

describe("expandedContextSlice", () => {
  let dir: string;
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "crw-expand-"));
    git("init", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    // 20 lines at base
    writeFileSync(join(dir, "f.ts"), Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n") + "\n");
    git("add", ".");
    git("commit", "-m", "base");
    // working tree: replace line 5 with two lines (net +1), delete line 12 (net 0 after)
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    lines.splice(11, 1); // delete "line12"
    lines.splice(4, 1, "line5 CHANGED", "line5b NEW");
    writeFileSync(join(dir, "f.ts"), lines.join("\n") + "\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("returns plain context with old == new above the first hunk", () => {
    const slice = expandedContextSlice("main", "f.ts", 1, 2, dir);
    expect(slice).toEqual([
      { type: "context", oldLine: 1, newLine: 1, text: "line1" },
      { type: "context", oldLine: 2, newLine: 2, text: "line2" },
    ]);
  });

  it("reconstructs shifted old-side numbers below a hunk", () => {
    // After +1 at line 5, new line 8 is old line 7.
    const slice = expandedContextSlice("main", "f.ts", 8, 8, dir);
    expect(slice).toEqual([{ type: "context", oldLine: 7, newLine: 8, text: "line7" }]);
  });

  it("emits real added/removed rows when the range crosses a hunk", () => {
    const slice = expandedContextSlice("main", "f.ts", 4, 7, dir);
    const types = slice.map((l) => `${l.type}:${l.text}`);
    expect(types).toContain("removed:line5");
    expect(types).toContain("added:line5 CHANGED");
    expect(types).toContain("added:line5b NEW");
    expect(types).toContain("context:line4");
  });

  it("clamps to EOF and returns [] past the end", () => {
    // working tree has 20 lines (one replaced by two, one deleted)
    const tail = expandedContextSlice("main", "f.ts", 19, 999, dir);
    expect(tail.length).toBe(2);
    expect(tail[tail.length - 1].newLine).toBe(20);
    expect(expandedContextSlice("main", "f.ts", 21, 30, dir)).toEqual([]);
  });

  it("accounts for all hunks above when mapping old numbers near the file end", () => {
    // +1 (line 5 split) then -1 (line 12 deleted) → old == new again below both.
    const slice = expandedContextSlice("main", "f.ts", 18, 18, dir);
    expect(slice).toEqual([{ type: "context", oldLine: 18, newLine: 18, text: "line18" }]);
  });
});

describe("anchorRowRange", () => {
  const lines: DiffLine[] = [
    { type: "context", oldLine: 10, newLine: 10, text: "ctx" },     // idx 0
    { type: "removed", oldLine: 11, newLine: null, text: "gone" },  // idx 1
    { type: "added", oldLine: null, newLine: 11, text: "new1" },    // idx 2
    { type: "context", oldLine: 12, newLine: 12, text: "ctx" },     // idx 3
    { type: "added", oldLine: null, newLine: 13, text: "new2" },    // idx 4
  ];
  const a = (startLine: number, startSide: "old" | "new", endLine: number, endSide: "old" | "new"): CommentAnchor =>
    ({ startLine, startSide, endLine, endSide });

  it("resolves a single added line", () => {
    expect(anchorRowRange(lines, a(11, "new", 11, "new"))).toEqual({ startIdx: 2, endIdx: 2 });
  });
  it("resolves a mixed-side range (removed -> added) spanning context", () => {
    expect(anchorRowRange(lines, a(11, "old", 13, "new"))).toEqual({ startIdx: 1, endIdx: 4 });
  });
  it("rejects a context line as endpoint", () => {
    expect(anchorRowRange(lines, a(12, "new", 13, "new"))).toBeNull();
  });
  it("rejects a line not in the diff", () => {
    expect(anchorRowRange(lines, a(99, "new", 99, "new"))).toBeNull();
  });
  it("rejects an inverted range (rendered order)", () => {
    expect(anchorRowRange(lines, a(13, "new", 11, "old"))).toBeNull();
  });
  it("rejects a wrong-side endpoint (added line addressed as old)", () => {
    expect(anchorRowRange(lines, a(11, "old", 11, "new"))).toEqual({ startIdx: 1, endIdx: 2 });
    expect(anchorRowRange(lines, a(13, "old", 13, "old"))).toBeNull();
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

describe("subtreeFingerprint", () => {
  function makeRepo(): { dir: string; git: (...a: string[]) => string } {
    const dir = mkdtempSync(join(tmpdir(), "crw-subtree-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
    git("init", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    mkdirSync(join(dir, "a"));
    mkdirSync(join(dir, "b"));
    writeFileSync(join(dir, "a", "f.txt"), "a1\n");
    writeFileSync(join(dir, "b", "f.txt"), "b1\n");
    git("add", ".");
    git("commit", "-m", "init");
    return { dir, git };
  }

  it("moves when the subtree changes and stays put when a sibling changes", () => {
    const { dir } = makeRepo();
    try {
      const a1 = subtreeFingerprint("a", dir);
      const b1 = subtreeFingerprint("b", dir);
      writeFileSync(join(dir, "b", "f.txt"), "b2\n");
      expect(subtreeFingerprint("a", dir)).toBe(a1);
      expect(subtreeFingerprint("b", dir)).not.toBe(b1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a commit touching only a sibling leaves the key unchanged (tree sha, not HEAD)", () => {
    const { dir, git } = makeRepo();
    try {
      const a1 = subtreeFingerprint("a", dir);
      writeFileSync(join(dir, "b", "f.txt"), "b2\n");
      git("add", ".");
      git("commit", "-m", "touch b only");
      expect(subtreeFingerprint("a", dir)).toBe(a1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sees untracked files under the subtree, including in a root absent at HEAD", () => {
    const { dir } = makeRepo();
    try {
      mkdirSync(join(dir, "newroot"));
      writeFileSync(join(dir, "newroot", "x.py"), "one\n");
      const k1 = subtreeFingerprint("newroot", dir);
      expect(k1).not.toBeNull();
      writeFileSync(join(dir, "newroot", "x.py"), "two\n");
      expect(subtreeFingerprint("newroot", dir)).not.toBe(k1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("subdir '' fingerprints the whole repo", () => {
    const { dir } = makeRepo();
    try {
      const k1 = subtreeFingerprint("", dir);
      writeFileSync(join(dir, "a", "f.txt"), "a2\n");
      expect(subtreeFingerprint("", dir)).not.toBe(k1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when git is unavailable", () => {
    const dir = mkdtempSync(join(tmpdir(), "crw-subtree-nogit-"));
    try {
      expect(subtreeFingerprint("a", dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with pathspecs, only moves when files of that language (or its markers) change", () => {
    const dir = mkdtempSync(join(tmpdir(), "crw-fp-lang-"));
    try {
      const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
      g("init", "-b", "main");
      g("config", "user.email", "t@t");
      g("config", "user.name", "t");
      writeFileSync(join(dir, "package.json"), "{}");
      writeFileSync(join(dir, "a.ts"), "export const x = 1;\n");
      writeFileSync(join(dir, "tsconfig.base.json"), "{}");
      mkdirSync(join(dir, "mcp", "svc"), { recursive: true });
      writeFileSync(join(dir, "mcp", "svc", "pyproject.toml"), "[project]\n");
      writeFileSync(join(dir, "mcp", "svc", "b.py"), "x = 1\n");
      g("add", ".");
      g("commit", "-m", "init");

      const tsSpecs = languagePathspecs("ts", "");
      const pySpecs = languagePathspecs("py", "mcp/svc");
      const ts1 = subtreeFingerprint("", dir, tsSpecs);
      const py1 = subtreeFingerprint("mcp/svc", dir, pySpecs);

      // Editing a nested python file must NOT move the repo-root ts key.
      writeFileSync(join(dir, "mcp", "svc", "b.py"), "x = 2\n");
      expect(subtreeFingerprint("", dir, tsSpecs)).toBe(ts1);
      expect(subtreeFingerprint("mcp/svc", dir, pySpecs)).not.toBe(py1);

      // Editing a top-level ts file moves the ts key (zero-depth ** match), not py.
      const py2 = subtreeFingerprint("mcp/svc", dir, pySpecs);
      writeFileSync(join(dir, "a.ts"), "export const x = 2;\n");
      expect(subtreeFingerprint("", dir, tsSpecs)).not.toBe(ts1);
      expect(subtreeFingerprint("mcp/svc", dir, pySpecs)).toBe(py2);

      // Editing a ts marker file moves the ts key.
      const ts2 = subtreeFingerprint("", dir, tsSpecs);
      writeFileSync(join(dir, "package.json"), '{"name":"x"}');
      expect(subtreeFingerprint("", dir, tsSpecs)).not.toBe(ts2);

      // An untracked python file moves only the py key.
      const ts3 = subtreeFingerprint("", dir, tsSpecs);
      const py3 = subtreeFingerprint("mcp/svc", dir, pySpecs);
      writeFileSync(join(dir, "mcp", "svc", "c.py"), "y = 1\n");
      expect(subtreeFingerprint("", dir, tsSpecs)).toBe(ts3);
      expect(subtreeFingerprint("mcp/svc", dir, pySpecs)).not.toBe(py3);

      // Editing a fingerprint-only config chain file (tsconfig.base.json,
      // not a marker) still moves the ts key — indexers follow `extends`.
      const ts4 = subtreeFingerprint("", dir, tsSpecs);
      writeFileSync(join(dir, "tsconfig.base.json"), '{"compilerOptions":{}}');
      expect(subtreeFingerprint("", dir, tsSpecs)).not.toBe(ts4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
