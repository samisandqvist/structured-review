import { describe, expect, it } from "vitest";
import { assessCoverage, uncoveredBranches } from "../../scripts/harness/coverage.mjs";
const branch = (line) => ({ type: "branch", locations: [{ start: { line, column: 0 }, end: { line, column: 10 } }] });
function report(duplicate = false) {
  return {
    statementMap: { 0: { start: { line: 1 } } },
    s: { 0: 1 },
    fnMap: {},
    f: {},
    branchMap: { 0: branch(1), 1: branch(2), ...(duplicate ? { 2: branch(1) } : {}) },
    b: { 0: [1], 1: [0], ...(duplicate ? { 2: [1] } : {}) },
  };
}
describe("legacy uncovered-branch location ratchet", () => {
  it("ignores unstable covered duplicate records but preserves strict percentages", () => {
    const original = report(true);
    const current = report(false);
    const floor = { "a.ts": { lines: 100, statements: 100, functions: 100, branches: 66 } };
    const debt = { "a.ts": uncoveredBranches(original) };
    expect(uncoveredBranches(current)).toEqual(uncoveredBranches(original));
    expect(assessCoverage({ "a.ts": current }, ["a.ts"], floor, debt)).toEqual([]);
    expect(assessCoverage({ "a.ts": current }, ["a.ts"]).join(" ")).toMatch(/branches 50 < 90/);
    current.b[0] = [0];
    expect(assessCoverage({ "a.ts": current }, ["a.ts"], floor, debt).join(" ")).toMatch(/new uncovered branch/);
  });
  it("rejects shifted gaps, repeated uncovered outcomes, and corrupt debt metadata", () => {
    const current = report();
    const originalDebt = uncoveredBranches(current);
    current.branchMap[1] = branch(3);
    expect(assessCoverage({ "a.ts": current }, ["a.ts"], {}, { "a.ts": originalDebt }).join(" ")).toMatch(
      /new uncovered branch/,
    );
    current.branchMap[2] = branch(3);
    current.b[2] = [0];
    expect(assessCoverage({ "a.ts": current }, ["a.ts"], {}, { "a.ts": uncoveredBranches(report()) }).length).toBe(2);
    expect(() => assessCoverage({ "a.ts": current }, ["a.ts"], {}, { "a.ts": [null] })).toThrow(/branch debt/);
    current.branchMap[1].locations[0] = {};
    expect(() => uncoveredBranches(current)).toThrow(/branch location/);
  });
  it("rejects malformed branch coordinates rather than inventing comparable locations", () => {
    const current = report();
    for (const point of [
      undefined,
      {},
      { line: 0, column: 0 },
      { line: 2, column: -1 },
      { line: 2, column: 0.5 },
      { line: 2.5, column: 0 },
    ]) {
      current.branchMap[1] = branch(2);
      current.branchMap[1].locations[0].end = point;
      expect(() => uncoveredBranches(current)).toThrow(/branch location/);
    }
    current.branchMap[1] = branch(2);
    delete current.branchMap[1].type;
    expect(() => uncoveredBranches(current)).toThrow(/branch location/);
  });
});
