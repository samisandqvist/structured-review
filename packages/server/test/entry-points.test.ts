import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { loadConfiguredEntries, isExportedAt, entryEvidence } from "../src/graph/entry-points.js";

describe("entryEvidence", () => {
  it("scores configured entries 1.0 regardless of other flags", () => {
    expect(entryEvidence({ isRoot: false, isExported: false, isConfigured: true }))
      .toEqual({ reasons: ["configured"], confidence: 1.0 });
    expect(entryEvidence({ isRoot: true, isExported: true, isConfigured: true }))
      .toEqual({ reasons: ["graph-root", "exported", "configured"], confidence: 1.0 });
  });
  it("scores exported graph roots 0.7", () => {
    expect(entryEvidence({ isRoot: true, isExported: true, isConfigured: false }))
      .toEqual({ reasons: ["graph-root", "exported"], confidence: 0.7 });
  });
  it("scores bare graph roots 0.4", () => {
    expect(entryEvidence({ isRoot: true, isExported: false, isConfigured: false }))
      .toEqual({ reasons: ["graph-root"], confidence: 0.4 });
  });
});

describe("loadConfiguredEntries", () => {
  it("reads .crw-entry-points.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "crw-entries-"));
    writeFileSync(join(dir, ".crw-entry-points.json"),
      JSON.stringify({ entryPoints: [{ label: "main", file: "src/cli.ts" }] }));
    expect(loadConfiguredEntries(dir)).toEqual([{ label: "main", file: "src/cli.ts" }]);
  });
  it("returns [] when the file is missing or invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "crw-entries-"));
    expect(loadConfiguredEntries(dir)).toEqual([]);
    writeFileSync(join(dir, ".crw-entry-points.json"), "{not json");
    expect(loadConfiguredEntries(dir)).toEqual([]);
  });
});

describe("isExportedAt", () => {
  it("detects an export keyword at the definition line", () => {
    const dir = mkdtempSync(join(tmpdir(), "crw-exp-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "const x = 1;\nexport function foo() {}\nfunction bar() {}\n");
    expect(isExportedAt(dir, "src/a.ts", 2)).toBe(true);
    expect(isExportedAt(dir, "src/a.ts", 3)).toBe(false);
  });
  it("returns false for unreadable files", () => {
    expect(isExportedAt("/nonexistent", "nope.ts", 1)).toBe(false);
  });
  it("does not match 'export' as a substring of a method name (e.g. exportData)", () => {
    const dir = mkdtempSync(join(tmpdir(), "crw-exp-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "b.ts"), "class Foo {\n  exportData() {\n    return 1;\n  }\n}\n");
    expect(isExportedAt(dir, "src/b.ts", 2)).toBe(false);
  });
});
