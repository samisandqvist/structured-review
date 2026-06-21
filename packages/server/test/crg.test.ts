import { describe, it, expect, vi } from "vitest";

const json = (obj: unknown) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn().mockImplementation((req: { name: string; arguments: Record<string, unknown> }) => {
      if (req.name === "get_impact_radius_tool") {
        return Promise.resolve(
          json({
            status: "ok",
            changed_nodes: [
              { id: 1, kind: "Function", name: "handler", qualified_name: "/repo/src/handler.ts::handler", file_path: "/repo/src/handler.ts", line_start: 10, line_end: 20 },
              // A File node — must be filtered out (too coarse for the call graph).
              { id: 3, kind: "File", name: "/repo/src/handler.ts", qualified_name: "/repo/src/handler.ts", file_path: "/repo/src/handler.ts", line_start: 1, line_end: 30 },
            ],
            impacted_nodes: [
              { id: 2, kind: "Function", name: "helper", qualified_name: "/repo/src/helper.ts::helper", file_path: "/repo/src/helper.ts", line_start: 1, line_end: 5 },
            ],
            edges: [
              { kind: "CALLS", source: "/repo/src/handler.ts::handler", target: "/repo/src/helper.ts::helper" },
              // Non-CALLS edge — must be dropped.
              { kind: "CONTAINS", source: "/repo/src/handler.ts", target: "/repo/src/handler.ts::handler" },
            ],
          })
        );
      }
      if (req.name === "query_graph_tool") {
        const pattern = req.arguments.pattern;
        if (pattern === "callers_of") return Promise.resolve(json({ status: "ok", results: [] }));
        return Promise.resolve(
          json({
            status: "ok",
            results: [
              { id: 2, kind: "Function", name: "helper", qualified_name: "/repo/src/helper.ts::helper", file_path: "/repo/src/helper.ts", line_start: 1, line_end: 5 },
              // Unresolved built-in (no file/id) — must be skipped.
              { kind: "Function", name: "filter", qualified_name: "filter" },
            ],
          })
        );
      }
      return Promise.resolve(json({ status: "ok" }));
    }),
  })),
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({ close: vi.fn().mockResolvedValue(undefined) })),
}));

import { CrgGraphProvider } from "../src/graph/crg.js";

const provider = () =>
  new CrgGraphProvider(["code-review-graph", "serve"], { repoRoot: "/repo", build: false });

describe("CrgGraphProvider", () => {
  it("maps get_impact_radius into a change subgraph", async () => {
    const subgraph = await provider().getChangeSubgraph("feat", "main");
    // File node filtered; only the two function nodes remain.
    expect(subgraph.nodes).toHaveLength(2);
    const handler = subgraph.nodes.find((n) => n.label === "handler")!;
    expect(handler.stableId).toBe("/repo/src/handler.ts::handler");
    expect(handler.file).toBe("src/handler.ts"); // relativized to repo root
    expect(handler.changeStatus).toBe("changed");
    expect(handler.isEntryPoint).toBe(true); // nothing calls it within the subgraph
    const helper = subgraph.nodes.find((n) => n.label === "helper")!;
    expect(helper.changeStatus).toBe("unchanged");
    // Only the CALLS edge survives.
    expect(subgraph.edges).toEqual([
      { sourceStableId: "/repo/src/handler.ts::handler", targetStableId: "/repo/src/helper.ts::helper", edgeType: "call" },
    ]);
  });

  it("returns callers and callees, skipping unresolved built-ins", async () => {
    const neighbors = await provider().getNeighbors("/repo/src/handler.ts::handler");
    expect(neighbors.callers).toHaveLength(0);
    expect(neighbors.callees).toHaveLength(1);
    expect(neighbors.callees[0].label).toBe("helper");
    expect(neighbors.callees[0].changeStatus).toBe("unchanged");
  });
});
