import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFiles } from "../src/diff.js";

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
