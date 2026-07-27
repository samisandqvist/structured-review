// packages/skill/test/api.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn(() => ({ unref: vi.fn() })), execFileSync: vi.fn() }));

import { briefContext, compactContext, createSession, writePlan, exportComments, defaultPartition, uiUrl, parsePlanFile, resolveBaseAlias, resolvePlanRefs, suggestMerges, EMPTY_TREE_SHA } from "../src/api.js";

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

describe("suggestMerges", () => {
  const flow = (entry: string, changed: string[]) => ({ entryStableId: entry, name: entry, changedStableIds: changed });

  it("groups flows sharing at least half of the smaller changed set", () => {
    const flows = [flow("a", ["x", "y", "z"]), flow("b", ["x", "y", "q"]), flow("c", ["p"])];
    const s = suggestMerges(flows);
    expect(s).toHaveLength(1);
    expect(s[0].entryStableIds).toEqual(["a", "b"]);
    expect(s[0].names).toEqual(["a", "b"]);
    expect(s[0].pairs).toEqual([{ a: "a", b: "b", shared: 2, smaller: 3 }]);
  });

  it("chains transitively into one component", () => {
    const flows = [flow("a", ["1", "2"]), flow("b", ["2", "3"]), flow("c", ["3", "4"])];
    const s = suggestMerges(flows);
    expect(s).toHaveLength(1);
    expect(s[0].entryStableIds).toEqual(["a", "b", "c"]);
    expect(s[0].pairs).toHaveLength(2);
  });

  it("suggests nothing for disjoint or below-threshold flows", () => {
    expect(suggestMerges([flow("a", ["1"]), flow("b", ["2"])])).toEqual([]);
    // shared 1 < half of smaller (3)
    expect(suggestMerges([flow("a", ["1", "2", "3"]), flow("b", ["3", "4", "5"])])).toEqual([]);
  });
});

describe("resolvePlanRefs", () => {
  const flows = [
    { id: 127, name: "handleOrder", entryStableId: "scip:long-entry-a" },
    { id: 142, name: "processOrder", entryStableId: "scip:long-entry-b" },
  ];
  const suggestions = [
    { entryStableIds: ["scip:long-entry-a", "scip:long-entry-b"], names: ["handleOrder", "processOrder"], pairs: [] },
  ];

  it("expands flowIds to entry stableIds (issue #7)", () => {
    const units = resolvePlanRefs(
      [{ kind: "flow", flowIds: [127], label: "Orders" }],
      flows, suggestions
    );
    expect(units).toEqual([{ kind: "flow", flowEntryStableIds: ["scip:long-entry-a"], label: "Orders" }]);
  });

  it("expands mergeGroup to the suggestion's entry set", () => {
    const units = resolvePlanRefs(
      [{ kind: "flow", mergeGroup: 0, label: "Order validation" }],
      flows, suggestions
    );
    expect(units[0]).toEqual({
      kind: "flow",
      flowEntryStableIds: ["scip:long-entry-a", "scip:long-entry-b"],
      label: "Order validation",
    });
  });

  it("merges numeric refs with explicit entries, deduped, singular field folded in", () => {
    const units = resolvePlanRefs(
      [{ kind: "flow", flowEntryStableId: "scip:long-entry-a", flowIds: [127, 142], label: "mix" }],
      flows, suggestions
    );
    expect(units[0]).toEqual({
      kind: "flow",
      flowEntryStableIds: ["scip:long-entry-a", "scip:long-entry-b"],
      label: "mix",
    });
  });

  it("leaves stableId-only flow units and orphan units untouched", () => {
    const input = [
      { kind: "flow" as const, flowEntryStableIds: ["scip:long-entry-a"], label: "plain" },
      { kind: "orphans" as const, orphanFiles: ["docs/**"], label: "docs" },
    ];
    expect(resolvePlanRefs(input, flows, suggestions)).toEqual(input);
  });

  it("throws a named error on unknown flowId or out-of-range mergeGroup", () => {
    expect(() => resolvePlanRefs([{ kind: "flow", flowIds: [999], label: "bad" }], flows, suggestions))
      .toThrow(/unit 'bad': unknown flowId 999.*127, 142/);
    expect(() => resolvePlanRefs([{ kind: "flow", mergeGroup: 3, label: "bad" }], flows, suggestions))
      .toThrow(/unit 'bad': mergeGroup 3 out of range \(1 suggestion/);
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

  it("reduces orphans to stableId/label/file/residualKind, grouped by directory", () => {
    const compact = compactContext(flows as never, orphans as never);
    expect(compact.orphanGroups).toEqual([
      {
        dir: "docs",
        orphans: [{ stableId: "file-residual:docs/x.md", label: "x.md", file: "docs/x.md", residualKind: "whole-file" }],
      },
    ]);
  });

  it("groups orphans by directory, '.' for the repo root, sorted", () => {
    const many = [
      { stableId: "d2", label: "y.md", file: "docs/y.md" },
      { stableId: "r1", label: "pkg", file: "package.json" },
      { stableId: "d1", label: "x.md", file: "docs/x.md" },
    ];
    const { orphanGroups } = compactContext([] as never, many as never);
    expect(orphanGroups.map((g) => g.dir)).toEqual([".", "docs"]);
    expect(orphanGroups[1].orphans.map((o) => o.stableId)).toEqual(["d1", "d2"]);
  });
});

describe("briefContext", () => {
  const step = (stableId: string, label: string, file: string) => ({
    stableId, label, file, startLine: 1, endLine: 9, isTest: false, depth: 0,
    nodeId: null, changeStatus: "changed", reviewStatus: null,
  });
  const flows = [
    {
      id: 127, name: "handleOrder", affected: true, entryStableId: "scip:long-a",
      changedStableIds: ["scip:long-a", "scip:shared"],
      steps: [step("scip:long-a", "handleOrder", "src/orders.ts")],
    },
    {
      id: 142, name: "processOrder", affected: true, entryStableId: "scip:long-b",
      changedStableIds: ["scip:long-b", "scip:shared"],
      steps: [step("scip:long-b", "processOrder", "src/process.ts")],
    },
    { id: 3, name: "unaffected", affected: false, entryStableId: "scip:long-c", changedStableIds: [], steps: [] },
  ];
  const orphans = [
    { stableId: "file-residual:docs/x.md", label: "x.md", file: "docs/x.md" },
    { stableId: "file-residual:.gitignore", label: ".gitignore", file: ".gitignore" },
  ];
  const changes = [{
    stableId: "scip:long-a", label: "handleOrder", kind: "function", file: "src/orders.ts",
    startLine: 10, endLine: 42, status: "modified", added: 12, removed: 3, signature: "export function handleOrder()",
  }];

  it("contains no stableIds anywhere (issue #8)", () => {
    const brief = briefContext(flows as never, orphans as never, changes);
    expect(JSON.stringify(brief)).not.toContain("scip:");
    expect(JSON.stringify(brief)).not.toContain("file-residual:");
  });

  it("names flows by numeric id with a short human entry", () => {
    const brief = briefContext(flows as never, orphans as never, changes);
    expect(brief.flows).toEqual([
      { id: 127, name: "handleOrder", entry: "handleOrder — src/orders.ts", changedCount: 2 },
      { id: 142, name: "processOrder", entry: "processOrder — src/process.ts", changedCount: 2 },
    ]);
  });

  it("numbers merge suggestions and refers to flows by id — the refs resolvePlanRefs accepts", () => {
    const brief = briefContext(flows as never, orphans as never, changes);
    expect(brief.mergeSuggestions).toEqual([
      { group: 0, flowIds: [127, 142], names: ["handleOrder", "processOrder"] },
    ]);
  });

  it("reduces orphan groups to directory + file list and changes to file/lines summaries", () => {
    const brief = briefContext(flows as never, orphans as never, changes);
    expect(brief.orphanGroups).toEqual([
      { dir: ".", files: [".gitignore"] },
      { dir: "docs", files: ["docs/x.md"] },
    ]);
    expect(brief.changes).toEqual([
      { file: "src/orders.ts", lines: "10-42", label: "handleOrder", kind: "function", status: "modified", added: 12, removed: 3 },
    ]);
  });
});
