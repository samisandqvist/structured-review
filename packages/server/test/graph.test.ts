import { describe, it, expect } from "vitest";
import { StubGraphProvider } from "../src/graph/stub.js";

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
