// packages/skill/test/orchestrate.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn(() => ({ unref: vi.fn() })) }));

import { createSession, writePlan, exportComments, defaultPartition } from "../src/orchestrate.js";

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

  it("exports comments as an ordered array envelope", async () => {
    const comments = [
      { id: "cmt1", nodeId: "node1", stableId: "fn:handleOrder", label: "handleOrder", file: "src/orders.ts", hunkSnippet: "s1", text: "first", structuralContext: "ctxA", createdAt: 1 },
      { id: "cmt2", nodeId: "node1", stableId: "fn:handleOrder", label: "handleOrder", file: "src/orders.ts", hunkSnippet: "s2", text: "second", structuralContext: "ctxB", createdAt: 2 },
    ];
    mockFetch.mockResolvedValueOnce(mockResponse({ comments }));
    const result = await exportComments("s1");
    expect(result.comments).toHaveLength(2);
    expect(result.comments.map((c) => c.text)).toEqual(["first", "second"]);
  });
});

describe("defaultPartition", () => {
  it("makes one flow-unit per affected flow plus an orphan unit", () => {
    const flows = [
      { id: 1, name: "handleOrder", affected: true, entryStableId: "fn:handleOrder", steps: [] },
      { id: 2, name: "unused", affected: false, entryStableId: "fn:unused", steps: [] },
    ];
    const orphans = [{ stableId: "fn:helper", label: "helper", file: "h.ts" }];
    const units = defaultPartition(flows as any, orphans as any);
    expect(units).toEqual([
      { kind: "flow", flowEntryStableId: "fn:handleOrder", label: "handleOrder" },
      { kind: "orphans", orphanStableIds: ["fn:helper"], label: "Other changes" },
    ]);
  });
});

describe("writePlan", () => {
  it("PUTs kind-tagged units and returns coverage", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ units: [], coverage: { changedTotal: 1, covered: 1, unassigned: 0 } }));
    const r = await writePlan("s1", [{ kind: "flow", flowEntryStableId: "fn:a", label: "A" }]);
    expect(r.coverage.unassigned).toBe(0);
    expect(mockFetch).toHaveBeenCalledWith("http://localhost:3456/api/sessions/s1/plan", expect.objectContaining({ method: "PUT" }));
  });
});
