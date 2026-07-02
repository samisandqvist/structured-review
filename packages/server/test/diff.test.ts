import { describe, it, expect } from "vitest";
import { extractHunkDiff, nodeChangeStats, subtractRanges } from "../src/diff.js";

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
