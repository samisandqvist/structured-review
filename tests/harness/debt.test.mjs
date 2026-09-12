import { describe, expect, it } from "vitest";
import { newFindings, lintFindings, knipFindings } from "../../scripts/harness/debt.mjs";

describe("explicit transitional debt", () => {
  it("allows only the recorded number of identical existing findings", () => {
    expect(newFindings(["old", "new", "old"], { old: 1 })).toEqual(["new", "old"]);
    expect(newFindings(["old"], { old: 1 })).toEqual([]);
    expect(newFindings([], { old: 1 })).toEqual([]);
    expect(() => newFindings(["new"], null)).toThrow(/baseline/);
  });
  it.each([Number.NaN, "1", -1, [], 1.5])("rejects invalid baseline count %j", (count) => {
    expect(() => newFindings(["old"], { old: count })).toThrow(/baseline count/);
  });
  it("rejects malformed findings and baseline containers", () => {
    expect(() => newFindings("old", { old: 1 })).toThrow(/findings/);
    expect(() => newFindings([1], { old: 1 })).toThrow(/findings/);
    expect(() => newFindings([], [])).toThrow(/baseline/);
    expect(() => newFindings([], new Date())).toThrow(/baseline/);
  });
  it("identifies lint debt by relative file, rule, source line and message", () => {
    const result = {
      filePath: "/repo/a.ts",
      source: "const a = 1;\n",
      messages: [{ line: 1, ruleId: "rule", message: "bad" }],
    };
    expect(lintFindings([result], "/repo")).toEqual(["a.ts|rule|bad|const a = 1;"]);
    expect(
      lintFindings(
        [{ filePath: "/repo/a.ts", messages: [{ line: 1, fatal: true, message: "parse error" }] }],
        "/repo",
      )[0],
    ).toContain("parse error");
  });
  it("keeps every unused file, symbol, and dependency from real Knip shapes", () => {
    const report = {
      files: ["standalone.ts", { name: "object-file.ts" }],
      issues: [
        {
          file: "a.ts",
          exports: [{ name: "missing", line: 2, col: 1, pos: 10 }],
          dependencies: [{ name: "unused", line: 1, col: 1, pos: 0 }],
          files: [{ name: "nested.ts" }],
          types: [],
        },
      ],
    };
    expect(knipFindings(report)).toEqual([
      "standalone.ts|files|standalone.ts",
      "object-file.ts|files|object-file.ts",
      "a.ts|exports|missing",
      "a.ts|dependencies|unused",
      "a.ts|files|nested.ts",
    ]);
  });
  it("deduplicates a file repeated by top-level and issue report forms", () => {
    expect(knipFindings({ files: ["a.ts"], issues: [{ file: "a.ts", files: [{ name: "a.ts" }] }] })).toEqual([
      "a.ts|files|a.ts",
    ]);
  });
  it.each([
    null,
    {},
    { issues: {} },
    { issues: [], files: {} },
    { issues: [null] },
    { issues: [{ file: "", exports: [] }] },
    { issues: [{ file: "a.ts", exports: {} }] },
    { issues: [{ file: "a.ts", exports: [{}] }] },
    { issues: [], files: [42] },
    new Date(),
  ])("rejects malformed Knip report %#", (report) => {
    expect(() => knipFindings(report)).toThrow(/unused-code/);
  });
});
