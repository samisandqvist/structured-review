import { describe, it, expect, vi } from "vitest";

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn().mockImplementation((req: { name: string }) => {
      const responses: Record<string, unknown> = {
        get_changed_nodes: { content: [{ text: JSON.stringify([
          { id: "fn:handler", name: "handler", filePath: "src/handler.ts", startLine: 10, endLine: 20, isEntryPoint: true, isChanged: true },
        ]) }] },
        get_changed_edges: { content: [{ text: JSON.stringify([
          { sourceId: "fn:handler", targetId: "fn:helper", type: "call" },
        ]) }] },
        get_callers: { content: [{ text: JSON.stringify([]) }] },
        get_callees: { content: [{ text: JSON.stringify([
          { id: "fn:helper", name: "helper", filePath: "src/helper.ts", startLine: 1, endLine: 5, isEntryPoint: false, isChanged: false },
        ]) }] },
      };
      return Promise.resolve(responses[req.name]);
    }),
  })),
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({ close: vi.fn().mockResolvedValue(undefined) })),
}));

import { CrgGraphProvider } from "../src/graph/crg.js";

describe("CrgGraphProvider", () => {
  it("returns a change subgraph from CRG", async () => {
    const provider = new CrgGraphProvider(["npx", "code-review-graph"]);
    const subgraph = await provider.getChangeSubgraph("feat", "main");
    expect(subgraph.nodes).toHaveLength(1);
    expect(subgraph.nodes[0].stableId).toBe("fn:handler");
    expect(subgraph.nodes[0].changeStatus).toBe("changed");
    expect(subgraph.edges).toHaveLength(1);
  });
  it("returns callers and callees", async () => {
    const provider = new CrgGraphProvider(["npx", "code-review-graph"]);
    const neighbors = await provider.getNeighbors("fn:handler");
    expect(neighbors.callers).toHaveLength(0);
    expect(neighbors.callees).toHaveLength(1);
    expect(neighbors.callees[0].changeStatus).toBe("unchanged");
  });
});
