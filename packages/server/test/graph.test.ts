import { describe, it, expect } from "vitest";
import { StubGraphProvider } from "../src/graph/stub.js";
import { reachesChanged, buildFlowTree } from "../src/graph/flow-tree.js";

describe("StubGraphProvider", () => {
  it("returns a change subgraph with nodes and edges", async () => {
    const provider = new StubGraphProvider();
    const subgraph = await provider.getChangeSubgraph("feat", "main");
    expect(subgraph.nodes.length).toBeGreaterThan(0);
    expect(subgraph.edges.length).toBeGreaterThan(0);
    expect(subgraph.nodes.filter(n => n.isEntryPoint).length).toBeGreaterThan(0);
  });
  it("returns callers and callees for a node", async () => {
    const provider = new StubGraphProvider();
    const neighbors = await provider.getNeighbors("fn:handleOrder");
    expect(neighbors.callers).toHaveLength(0);
    expect(neighbors.callees.some(n => n.stableId === "fn:validateOrder")).toBe(true);
  });
  it("returns callers for a callee node", async () => {
    const provider = new StubGraphProvider();
    const neighbors = await provider.getNeighbors("fn:validateOrder");
    expect(neighbors.callers.some(n => n.stableId === "fn:handleOrder")).toBe(true);
    expect(neighbors.callees).toHaveLength(0);
  });
});

const info = (label: string) => ({ label, file: "f.ts", startLine: 1, endLine: 2, isTest: false });
const adj = (pairs: [string, string[]][]) => new Map(pairs);

describe("reachesChanged", () => {
  it("includes changed nodes and all transitive callers", () => {
    const callAdj = adj([["a", ["b"]], ["b", ["c"]], ["x", ["y"]]]);
    expect([...reachesChanged(new Set(["c"]), callAdj)].sort()).toEqual(["a", "b", "c"]);
  });
  it("handles cycles", () => {
    const callAdj = adj([["a", ["b"]], ["b", ["a", "c"]]]);
    expect([...reachesChanged(new Set(["c"]), callAdj)].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("buildFlowTree with relevance", () => {
  const resolve = (s: string) => info(s);
  it("descends only into relevant callees; off-path callees are leaf context", () => {
    // entry -> hot -> changed ; entry -> cold -> deep (never visited)
    const callAdj = adj([["entry", ["hot", "cold"]], ["hot", ["changed"]], ["cold", ["deep"]]]);
    const relevant = reachesChanged(new Set(["changed"]), callAdj);
    const steps = buildFlowTree("entry", callAdj, resolve, relevant);
    expect(steps.map((s) => `${s.stableId}:${s.offPath ? "off" : "on"}`)).toEqual([
      "entry:on", "hot:on", "changed:on", "cold:off",
    ]);
  });
  it("an unaffected flow keeps entry + one-hop context", () => {
    const callAdj = adj([["entry", ["a", "b"]], ["a", ["a2"]]]);
    const steps = buildFlowTree("entry", callAdj, resolve, new Set());
    expect(steps.map((s) => s.stableId)).toEqual(["entry", "a", "b"]);
    expect(steps[0].offPath).toBe(false);
    expect(steps[1].offPath).toBe(true);
  });
  it("a changed node deeper than the step cap is still present", () => {
    const noise = Array.from({ length: 130 }, (_, i) => `noise${i}`);
    const callAdj = adj([["entry", ["n1", ...noise]], ["n1", ["changed"]]]);
    const relevant = reachesChanged(new Set(["changed"]), callAdj);
    const steps = buildFlowTree("entry", callAdj, resolve, relevant);
    expect(steps.some((s) => s.stableId === "changed")).toBe(true);
    expect(steps.filter((s) => s.offPath).length).toBeLessThanOrEqual(120);
  });
  it("without a relevant set behaves as before (no offPath flags set true)", () => {
    const callAdj = adj([["entry", ["a"]], ["a", ["b"]]]);
    const steps = buildFlowTree("entry", callAdj, resolve);
    expect(steps).toHaveLength(3);
    expect(steps.every((s) => !s.offPath)).toBe(true);
  });
});
