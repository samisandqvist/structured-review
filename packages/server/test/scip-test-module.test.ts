// Module-scope callers for test documents: vitest-style tests call the subject
// from anonymous callbacks, which have no named enclosing node. The document
// symbol scip-typescript emits for a test file stands in as the caller.
import { describe, it, expect } from "vitest";
import { buildGraphFromIndex, type ScipDocument } from "../src/graph/scip.js";

const SUBJECT = "scip-typescript npm pkg 1.0 src/`claims.ts`/resolve().";
const FIXTURE = "scip-typescript npm pkg 1.0 src/`config.ts`/load().";
const TEST_MODULE = "scip-typescript npm pkg 1.0 src/`claims.property.test.ts`/";
const TEST_HELPER = "scip-typescript npm pkg 1.0 src/`claims.property.test.ts`/helper().";
const PROD_MODULE = "scip-typescript npm pkg 1.0 src/`claims.ts`/";

const production: ScipDocument[] = [
  {
    relativePath: "src/claims.ts",
    occurrences: [
      { symbol: PROD_MODULE, symbolRoles: 1, range: [0, 0, 0], enclosingRange: [0, 0, 9, 0] },
      { symbol: SUBJECT, symbolRoles: 1, range: [2, 16, 23], enclosingRange: [2, 0, 6, 1] },
    ],
  },
  {
    relativePath: "src/config.ts",
    occurrences: [{ symbol: FIXTURE, symbolRoles: 1, range: [0, 16, 20], enclosingRange: [0, 0, 3, 1] }],
  },
];

const testDoc: ScipDocument = {
  relativePath: "src/claims.property.test.ts",
  occurrences: [
    { symbol: TEST_MODULE, symbolRoles: 1, range: [0, 0, 0], enclosingRange: [0, 0, 40, 0] },
    { symbol: FIXTURE, symbolRoles: 0, range: [4, 12, 16] }, // const cfg = load(...) at module scope
    { symbol: TEST_HELPER, symbolRoles: 1, range: [6, 9, 15], enclosingRange: [6, 0, 8, 1] },
    { symbol: SUBJECT, symbolRoles: 0, range: [7, 9, 16] }, // inside the named helper
    { symbol: SUBJECT, symbolRoles: 0, range: [12, 18, 25] }, // inside it(() => { ... })
    { symbol: SUBJECT, symbolRoles: 0, range: [20, 18, 25] }, // inside another it(() => { ... })
  ],
};

describe("module-scope caller for test documents", () => {
  const g = buildGraphFromIndex({ documents: [...production, testDoc] }, "/repo");

  it("makes the test document symbol a test node spanning the whole file, labelled by basename", () => {
    expect(g.nodes.get(TEST_MODULE)).toEqual({
      label: "claims.property.test.ts",
      file: "src/claims.property.test.ts",
      startLine: 1,
      endLine: 41,
      isTest: true,
    });
  });

  it("attributes references inside anonymous callbacks to the module node", () => {
    expect(g.callAdj.get(TEST_MODULE)?.sort()).toEqual([FIXTURE, SUBJECT].sort());
    expect(g.callRev.get(SUBJECT)).toContain(TEST_MODULE);
  });

  it("still attributes a reference inside a named test helper to the helper", () => {
    expect(g.callAdj.get(TEST_HELPER)).toEqual([SUBJECT]);
  });

  it("does not turn a production document symbol into a node", () => {
    expect(g.nodes.has(PROD_MODULE)).toBe(false);
  });

  it("ignores a test document symbol that carries no enclosing range", () => {
    const bare: ScipDocument = {
      relativePath: "src/other.test.ts",
      occurrences: [
        { symbol: "scip-typescript npm pkg 1.0 src/`other.test.ts`/", symbolRoles: 1, range: [0, 0, 0] },
        { symbol: SUBJECT, symbolRoles: 0, range: [3, 2, 9] },
      ],
    };
    const graph = buildGraphFromIndex({ documents: [...production, bare] }, "/repo");
    expect(graph.nodes.has("scip-typescript npm pkg 1.0 src/`other.test.ts`/")).toBe(false);
    expect(graph.callRev.get(SUBJECT)).toBeUndefined();
  });

  it("records how many times each caller references each callee", () => {
    expect(g.callWeights.get(TEST_MODULE)?.get(SUBJECT)).toBe(2);
    expect(g.callWeights.get(TEST_MODULE)?.get(FIXTURE)).toBe(1);
  });
});
