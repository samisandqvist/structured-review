// packages/skill/test/api.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn(() => ({ unref: vi.fn() })), execFileSync: vi.fn() }));

import { compactContext, createSession, writePlan, exportComments, defaultPartition, uiUrl, parsePlanFile, resolveBaseAlias, EMPTY_TREE_SHA } from "../src/api.js";

const BASE = "http://localhost:3456";
const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function mockResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 404, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) };
}

beforeEach(() => { mockFetch.mockClear(); });

describe("api client", () => {
  it("creates a session via the server API", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({
      session: { id: "s1", branch: "feat", baseRef: "main", status: "planning", createdAt: 0 },
      subgraph: { nodes: [], edges: [] },
    }));
    const result = await createSession(BASE, "feat", "main");
    expect(result.session.id).toBe("s1");
    expect(mockFetch).toHaveBeenCalledWith("http://localhost:3456/api/sessions", expect.objectContaining({ method: "POST" }));
  });

  it("exports comments as an ordered array envelope", async () => {
    const comments = [
      { id: "cmt1", nodeId: "node1", stableId: "fn:handleOrder", label: "handleOrder", file: "src/orders.ts", hunkSnippet: "s1", text: "first", structuralContext: "ctxA", createdAt: 1 },
      { id: "cmt2", nodeId: "node1", stableId: "fn:handleOrder", label: "handleOrder", file: "src/orders.ts", hunkSnippet: "s2", text: "second", structuralContext: "ctxB", createdAt: 2 },
    ];
    mockFetch.mockResolvedValueOnce(mockResponse({ comments }));
    const result = await exportComments(BASE, "s1");
    expect(result.comments).toHaveLength(2);
    expect(result.comments.map((c) => c.text)).toEqual(["first", "second"]);
  });

  it("builds the UI url from the hub base", () => {
    expect(uiUrl(BASE, "s1")).toBe("http://localhost:3456/?session=s1");
  });
});

describe("resolveBaseAlias", () => {
  it("maps 'empty' to the empty tree sha", () => {
    expect(resolveBaseAlias("empty")).toBe(EMPTY_TREE_SHA);
    expect(EMPTY_TREE_SHA).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });
  it("passes ordinary refs through", () => {
    expect(resolveBaseAlias("main")).toBe("main");
    expect(resolveBaseAlias("HEAD~3")).toBe("HEAD~3");
  });
});

describe("defaultPartition", () => {
  it("makes one flow-unit per affected flow and leaves orphans to server attachment", () => {
    const flows = [
      { id: 1, name: "handleOrder", affected: true, entryStableId: "fn:handleOrder", steps: [] },
      { id: 2, name: "unused", affected: false, entryStableId: "fn:unused", steps: [] },
    ];
    const orphans = [{ stableId: "fn:helper", label: "helper", file: "h.ts" }];
    const units = defaultPartition(flows as any, orphans as any);
    // No explicit orphan unit: explicit membership would block plan-time
    // attachment; leftovers get swept into the auto Unassigned unit instead.
    expect(units).toEqual([
      { kind: "flow", flowEntryStableId: "fn:handleOrder", label: "handleOrder" },
    ]);
  });
});

describe("writePlan", () => {
  it("PUTs kind-tagged units and returns coverage", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ units: [], coverage: { changedTotal: 1, covered: 1, unassigned: 0 }, overview: "" }));
    const r = await writePlan(BASE, "s1", [{ kind: "flow", flowEntryStableId: "fn:a", label: "A" }]);
    expect(r.coverage.unassigned).toBe(0);
    expect(mockFetch).toHaveBeenCalledWith("http://localhost:3456/api/sessions/s1/plan", expect.objectContaining({ method: "PUT" }));
  });
});

describe("parsePlanFile", () => {
  it("accepts the legacy bare-array format with no overview", () => {
    const parsed = parsePlanFile(JSON.stringify([{ kind: "flow", flowEntryStableId: "fn:a", label: "A" }]));
    expect(parsed.units).toHaveLength(1);
    expect(parsed.overview).toBeUndefined();
  });

  it("accepts { overview, units }", () => {
    const parsed = parsePlanFile(JSON.stringify({
      overview: "The change does X.",
      units: [{ kind: "orphans", orphanStableIds: ["fn:b"], label: "B" }],
    }));
    expect(parsed.units).toHaveLength(1);
    expect(parsed.overview).toBe("The change does X.");
  });

  it("rejects shapes that are neither", () => {
    expect(() => parsePlanFile(JSON.stringify({ overview: "no units here" }))).toThrow(/units/);
    expect(() => parsePlanFile(JSON.stringify("nope"))).toThrow(/units/);
  });
});

describe("compactContext", () => {
  const flows = [
    {
      id: 1, name: "handleOrder", affected: true, entryStableId: "fn:handleOrder",
      changedStableIds: ["fn:handleOrder", "fn:processOrder"],
      steps: [{ stableId: "fn:handleOrder", label: "handleOrder", file: "o.ts", startLine: 1, endLine: 2, isTest: false, depth: 0, nodeId: "n1", changeStatus: "changed", reviewStatus: "unreviewed" }],
    },
    {
      id: 2, name: "unrelated", affected: false, entryStableId: "fn:unrelated",
      changedStableIds: [],
      steps: [],
    },
  ];
  const orphans = [
    { stableId: "file-residual:docs/x.md", label: "x.md", file: "docs/x.md", residualKind: "whole-file", id: "n9", sessionId: "s1", startLine: 1, endLine: 5 },
  ];

  it("keeps only affected flows, without step arrays", () => {
    const compact = compactContext(flows as never, orphans as never);
    expect(compact.flows).toEqual([
      { id: 1, name: "handleOrder", entryStableId: "fn:handleOrder", changedStableIds: ["fn:handleOrder", "fn:processOrder"] },
    ]);
    expect("steps" in compact.flows[0]).toBe(false);
  });

  it("reduces orphans to stableId/label/file/residualKind", () => {
    const compact = compactContext(flows as never, orphans as never);
    expect(compact.orphans).toEqual([
      { stableId: "file-residual:docs/x.md", label: "x.md", file: "docs/x.md", residualKind: "whole-file" },
    ]);
  });
});
