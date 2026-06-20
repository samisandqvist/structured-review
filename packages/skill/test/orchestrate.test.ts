// packages/skill/test/orchestrate.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn(() => ({ unref: vi.fn() })) }));

import { createSession, writePlan, exportComments, orchestrate } from "../src/orchestrate.js";
import type { ChangeSubgraph } from "../src/orchestrate.js";

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function mockResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 404, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) };
}

beforeEach(() => { mockFetch.mockClear(); });

describe("orchestrate", () => {
  it("creates a session via the server API", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({
      session: { id: "s1", branch: "feat", baseRef: "main", status: "planning", createdAt: 0 },
      subgraph: { nodes: [], edges: [] },
    }));
    const result = await createSession("feat", "main");
    expect(result.session.id).toBe("s1");
    expect(mockFetch).toHaveBeenCalledWith("http://localhost:3456/api/sessions", expect.objectContaining({ method: "POST" }));
  });

  it("writes a plan", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ units: [] }));
    await writePlan("s1", [{ label: "U1", rationale: "r", entryPointNodeIds: [] }]);
    expect(mockFetch).toHaveBeenCalledWith("http://localhost:3456/api/sessions/s1/plan", expect.objectContaining({ method: "PUT" }));
  });

  it("exports comments", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ node1: { text: "fix" } }));
    const result = await exportComments("s1");
    expect(result).toEqual({ node1: { text: "fix" } });
  });

  it("orchestrates the full flow", async () => {
    const subgraph = {
      nodes: [{ stableId: "fn:a", label: "a", file: "a.ts", startLine: 1, endLine: 5, isEntryPoint: true, changeStatus: "changed" }],
      edges: [],
    };
    mockFetch
      .mockResolvedValueOnce(mockResponse({ session: { id: "s1", branch: "feat", baseRef: "main", status: "planning", createdAt: 0 }, subgraph }))
      .mockResolvedValueOnce(mockResponse({ units: [] }))
      .mockResolvedValueOnce(mockResponse({}));

    const partitionFn = vi.fn((s: ChangeSubgraph) => [
      { label: "Unit A", rationale: "all in one", entryPointNodeIds: s.nodes.map(n => n.stableId) },
    ]);

    await orchestrate("feat", "main", partitionFn);
    expect(partitionFn).toHaveBeenCalledWith(subgraph);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
