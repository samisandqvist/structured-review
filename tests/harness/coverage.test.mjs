import { describe, expect, it } from "vitest";
import { assessCoverage, changedExecutableCoverage, changedLines, metrics } from "../../scripts/harness/coverage.mjs";

const file = (hits = [1, 0]) => ({
  statementMap: { 0: { start: { line: 1 }, end: { line: 1 } }, 1: { start: { line: 3 }, end: { line: 3 } } },
  s: { 0: hits[0], 1: hits[1] },
  fnMap: { 0: {} },
  branchMap: { 0: { locations: [{}, {}] } },
  f: { 0: 1 },
  b: { 0: hits },
});
describe("coverage gates", () => {
  it("counts uncovered executable lines, functions and branch outcomes independently", () => {
    expect(metrics(file())).toEqual({ lines: 50, statements: 50, functions: 100, branches: 50 });
    expect(metrics({ statementMap: {}, fnMap: {}, branchMap: {}, s: {}, f: {}, b: {} })).toEqual({
      lines: 100,
      statements: 100,
      functions: 100,
      branches: 100,
    });
  });
  it("rejects missing and empty reports and missing maintained files", () => {
    expect(() => assessCoverage(null, ["a.ts"])).toThrow(/report/);
    expect(() => assessCoverage({}, ["a.ts"])).toThrow(/report/);
    expect(assessCoverage({ "a.ts": file([1, 1]) }, ["a.ts", "new.ts"])).toContain(
      "new.ts: missing from coverage report",
    );
  });
  it("keeps strict thresholds and rejects any per-file baseline regression", () => {
    expect(assessCoverage({ "a.ts": file() }, ["a.ts"]).join(" ")).toMatch(/lines 50 < 95/);
    const baseline = { "a.ts": { lines: 50, statements: 50, functions: 100, branches: 50 } };
    expect(assessCoverage({ "a.ts": file() }, ["a.ts"], baseline)).toEqual([]);
    expect(assessCoverage({ "a.ts": file([0, 0]) }, ["a.ts"], baseline).join(" ")).toMatch(/lines 0 < 50/);
    expect(assessCoverage({ "new.ts": file() }, ["new.ts"], baseline).length).toBeGreaterThan(0);
  });
  it("rejects corrupted hit counts and incomplete or nonnumeric policy floors", () => {
    for (const bad of [
      undefined,
      {},
      { ...file(), s: { 0: NaN, 1: 0 } },
      { ...file(), s: {} },
      { ...file(), f: {} },
      { ...file(), b: {} },
      { ...file(), b: { 0: [1] } },
      { ...file(), b: { 0: 1 } },
      { ...file(), branchMap: { 0: {} } },
      { ...file(), s: { 0: 0.01, 1: 1 } },
      { ...file(), b: { 0: [-1] } },
      { ...file(), statementMap: { 0: { start: { line: 0 } } } },
    ])
      expect(() => metrics(bad)).toThrow(/coverage/);
    for (const floor of [
      {},
      { lines: 0 },
      { lines: 0, statements: 0, functions: 0, branches: NaN },
      { lines: -1, statements: 0, functions: 0, branches: 0 },
    ])
      expect(() => assessCoverage({ "a.ts": file() }, ["a.ts"], { "a.ts": floor })).toThrow(/baseline/);
  });
  it("counts added ranges, treats deleted ranges as empty and rejects malformed patches", () => {
    expect(changedLines("@@ -1,2 +1,3 @@\n+x\n@@ -9 +10 @@\n+y")).toEqual([1, 2, 3, 10]);
    expect(changedLines("@@ -1,2 +0,0 @@\n-x")).toEqual([]);
    expect(() => changedLines("@@ malformed @@")).toThrow(/hunk/);
  });
  it("fails changed executable coverage even when overall coverage is good", () => {
    expect(changedExecutableCoverage(file(), [3])).toEqual({ covered: 0, total: 1, percent: 0 });
    expect(changedExecutableCoverage(file(), [1, 1, 2])).toEqual({ covered: 1, total: 1, percent: 100 });
    expect(changedExecutableCoverage(file(), [])).toEqual({ covered: 0, total: 0, percent: 100 });
    expect(() => changedExecutableCoverage(undefined, [1])).toThrow(/missing/);
  });
});
