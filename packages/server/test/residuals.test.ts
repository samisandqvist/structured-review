import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFiles } from "../src/diff.js";
import { computeResiduals } from "../src/residuals.js";

let dir: string;
const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "crw-resid-"));
  git("init", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "types.ts"), "export interface Order {\n  id: string;\n}\n");
  writeFileSync(join(dir, "orders.ts"), "export function handle() {\n  return 1;\n}\n");
  writeFileSync(join(dir, "gone.ts"), "export const X = 1;\n");
  // multi.ts: 45 lines; base version, unchanged everywhere.
  const multiBase = Array.from({ length: 45 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
  writeFileSync(join(dir, "multi.ts"), multiBase);
  git("add", ".");
  git("commit", "-m", "base");
  // working-tree changes vs main:
  writeFileSync(join(dir, "types.ts"), "export interface Order {\n  id: string;\n  total: number;\n}\n");
  writeFileSync(join(dir, "orders.ts"), 'import { z } from "zod";\nexport function handle() {\n  return 2;\n}\n');
  unlinkSync(join(dir, "gone.ts"));
  // multi.ts: change lines 2-3 (above the node span) and 40-41 (below it),
  // keeping line count identical so new-file line numbers match the base.
  const multiLines = Array.from({ length: 45 }, (_, i) => `line${i + 1}`);
  multiLines[1] = "line2 CHANGED";
  multiLines[2] = "line3 CHANGED";
  multiLines[39] = "line40 CHANGED";
  multiLines[40] = "line41 CHANGED";
  writeFileSync(join(dir, "multi.ts"), multiLines.join("\n") + "\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("changedFiles", () => {
  it("lists files changed vs baseRef", () => {
    expect(changedFiles("main", dir).sort()).toEqual(["gone.ts", "multi.ts", "orders.ts", "types.ts"]);
  });
  it("returns [] when git fails", () => {
    expect(changedFiles("main", "/nonexistent-root")).toEqual([]);
  });
});

describe("computeResiduals", () => {
  it("emits a whole-file pseudo-node for a changed file with no graph nodes", () => {
    const res = computeResiduals("main", new Map(), dir);
    const types = res.find((r) => r.file === "types.ts")!;
    expect(types.stableId).toBe("file-residual:types.ts");
    expect(types.label).toBe("types.ts");
    expect(types.kind).toBe("whole-file");
    expect(types.startLine).toBeGreaterThan(0);
    expect(types.isTest).toBe(false);
  });

  it("subtracts node spans and marks module-scope residuals", () => {
    // orders.ts change: import line 1 (residual) + body change inside the node span 2–4
    const spans = new Map([["orders.ts", [{ start: 2, end: 4 }]]]);
    const res = computeResiduals("main", spans, dir);
    const orders = res.find((r) => r.file === "orders.ts")!;
    expect(orders.label).toBe("orders.ts");
    expect(orders.kind).toBe("module-scope");
    expect(orders.startLine).toBe(1);
    expect(orders.endLine).toBe(1);
  });

  it("emits no pseudo-node when node spans cover all hunks", () => {
    const spans = new Map([["orders.ts", [{ start: 1, end: 10 }]]]);
    const res = computeResiduals("main", spans, dir);
    expect(res.find((r) => r.file === "orders.ts")).toBeUndefined();
  });

  it("marks a deleted file", () => {
    const res = computeResiduals("main", new Map(), dir);
    const gone = res.find((r) => r.file === "gone.ts")!;
    expect(gone.label).toBe("gone.ts");
    expect(gone.kind).toBe("deleted");
    expect(gone.startLine).toBe(0);
    expect(gone.endLine).toBe(0);
  });

  it("returns the exact residual ranges, not just the bounding box", () => {
    // fixture: multi.ts changes at lines 2-3 and 40-41, node span covering 10-30
    const spans = new Map([["multi.ts", [{ start: 10, end: 30 }]]]);
    const res = computeResiduals("main", spans, dir);
    const residuals = res.filter((r) => r.file === "multi.ts");
    expect(residuals).toHaveLength(1);
    expect(residuals[0].ranges).toEqual([
      { start: 2, end: 3 },
      { start: 40, end: 41 },
    ]);
    expect(residuals[0].startLine).toBe(2); // bounding box preserved
    expect(residuals[0].endLine).toBe(41);
  });
});
