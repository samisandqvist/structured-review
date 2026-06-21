import { describe, it, expect } from "vitest";
import { extractHunkDiff } from "../src/diff.js";

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
