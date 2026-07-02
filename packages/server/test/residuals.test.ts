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
  git("add", ".");
  git("commit", "-m", "base");
  // working-tree changes vs main:
  writeFileSync(join(dir, "types.ts"), "export interface Order {\n  id: string;\n  total: number;\n}\n");
  writeFileSync(join(dir, "orders.ts"), 'import { z } from "zod";\nexport function handle() {\n  return 2;\n}\n');
  unlinkSync(join(dir, "gone.ts"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("changedFiles", () => {
  it("lists files changed vs baseRef", () => {
    expect(changedFiles("main", dir).sort()).toEqual(["gone.ts", "orders.ts", "types.ts"]);
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
    expect(types.startLine).toBeGreaterThan(0);
    expect(types.isTest).toBe(false);
  });

  it("subtracts node spans and labels module-scope residuals", () => {
    // orders.ts change: import line 1 (residual) + body change inside the node span 2–4
    const spans = new Map([["orders.ts", [{ start: 2, end: 4 }]]]);
    const res = computeResiduals("main", spans, dir);
    const orders = res.find((r) => r.file === "orders.ts")!;
    expect(orders.label).toBe("orders.ts (module scope)");
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
    expect(gone.label).toBe("gone.ts (deleted)");
    expect(gone.startLine).toBe(0);
    expect(gone.endLine).toBe(0);
  });
});
