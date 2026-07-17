// Derivation passes for plan-time attachments (attach.ts).
import { describe, it, expect } from "vitest";
import { deriveAttachments, countedAttachmentIds, type AttachNode, type TestEdge } from "../src/attach.js";
import type { PlanUnitInput } from "../src/coverage.js";
import type { Flow, FlowStep } from "../src/graph/provider.js";

function node(stableId: string, over: Partial<AttachNode> = {}): AttachNode {
  return { stableId, file: `${stableId}.ts`, isTest: false, changeStatus: "changed", ...over };
}

function step(stableId: string, depth: number): FlowStep {
  return { stableId, label: stableId, file: `${stableId}.ts`, startLine: 1, endLine: 10, isTest: false, depth };
}

function flow(id: number, stepIds: string[]): Flow {
  return { id, name: stepIds[0], criticality: 1, depth: stepIds.length - 1, steps: stepIds.map((s, i) => step(s, i)) };
}

const flowUnit = (entry: string, label = entry): PlanUnitInput => ({ kind: "flow", flowEntryStableId: entry, label });
const orphanUnit = (ids: string[], label = "orphans"): PlanUnitInput => ({ kind: "orphans", orphanStableIds: ids, label });

describe("deriveAttachments — tested-by", () => {
  it("nests a changed test under the first exercised covered node in walk order", () => {
    const nodes = [node("a"), node("b"), node("t", { isTest: true, file: "t.test.ts" })];
    const flows = [flow(1, ["a", "b"])];
    const edges: TestEdge[] = [
      { productionStableId: "b", testStableId: "t" },
      { productionStableId: "a", testStableId: "t" },
    ];
    const [attached] = deriveAttachments([flowUnit("a")], flows, nodes, edges, new Map());
    expect(attached).toEqual([{ stableId: "t", parentStableId: "a", reason: "tested-by", counted: true }]);
  });

  it("adds a non-counting reference in other units, one per unit", () => {
    const nodes = [node("a"), node("b"), node("c"), node("t", { isTest: true, file: "t.test.ts" })];
    const flows = [flow(1, ["a"]), flow(2, ["b", "c"])];
    const edges: TestEdge[] = [
      { productionStableId: "a", testStableId: "t" },
      { productionStableId: "b", testStableId: "t" },
      { productionStableId: "c", testStableId: "t" },
    ];
    const attached = deriveAttachments([flowUnit("a"), flowUnit("b")], flows, nodes, edges, new Map());
    expect(attached[0]).toEqual([{ stableId: "t", parentStableId: "a", reason: "tested-by", counted: true }]);
    // b and c are both in unit 1 — only the first (b) carries the reference.
    expect(attached[1]).toEqual([{ stableId: "t", parentStableId: "b", reason: "tested-by", counted: false }]);
  });

  it("a test exercising only unassigned code stays unattached", () => {
    const nodes = [node("a"), node("x"), node("t", { isTest: true, file: "t.test.ts" })];
    const flows = [flow(1, ["a"])];
    const edges: TestEdge[] = [{ productionStableId: "x", testStableId: "t" }];
    const attached = deriveAttachments([flowUnit("a")], flows, nodes, edges, new Map());
    expect(attached.flat()).toEqual([]);
  });
});

describe("deriveAttachments — same-file", () => {
  it("nests a module-scope residual under the first covered node of its file", () => {
    const nodes = [node("svc.method"), node("svc (module scope)", { file: "svc.method.ts" })];
    const flows = [flow(1, ["svc.method"])];
    const [attached] = deriveAttachments([flowUnit("svc.method")], flows, nodes, [], new Map());
    expect(attached).toEqual([
      { stableId: "svc (module scope)", parentStableId: "svc.method", reason: "same-file", counted: true },
    ]);
  });
});

describe("deriveAttachments — required-by", () => {
  it("nests a DTO under the first covered consumer of its file", () => {
    const nodes = [node("ctrl"), node("dto", { file: "dto.ts" })];
    const flows = [flow(1, ["ctrl"])];
    const requires = new Map([["ctrl.ts", new Set(["dto.ts"])]]);
    const [attached] = deriveAttachments([flowUnit("ctrl")], flows, nodes, [], requires);
    expect(attached).toEqual([{ stableId: "dto", parentStableId: "ctrl", reason: "required-by", counted: true }]);
  });

  it("no consumer covered -> stays unattached (no chaining through attachments)", () => {
    // t (attached test) is in t.test.ts which requires dto.ts — but t is an
    // attachment, not a covered node, so dto must not chain onto it.
    const nodes = [node("a"), node("t", { isTest: true, file: "t.test.ts" }), node("dto", { file: "dto.ts" })];
    const flows = [flow(1, ["a"])];
    const edges: TestEdge[] = [{ productionStableId: "a", testStableId: "t" }];
    const requires = new Map([["t.test.ts", new Set(["dto.ts"])]]);
    const attached = deriveAttachments([flowUnit("a")], flows, nodes, edges, requires);
    expect(attached.flat()).toEqual([{ stableId: "t", parentStableId: "a", reason: "tested-by", counted: true }]);
  });
});

describe("deriveAttachments — precedence and explicit membership", () => {
  it("tested-by wins over same-file and required-by", () => {
    const nodes = [node("a", { file: "shared.ts" }), node("t", { isTest: true, file: "shared.ts" })];
    const flows = [flow(1, ["a"])];
    const edges: TestEdge[] = [{ productionStableId: "a", testStableId: "t" }];
    const requires = new Map([["shared.ts", new Set(["shared.ts"])]]);
    const [attached] = deriveAttachments([flowUnit("a")], flows, nodes, edges, requires);
    expect(attached[0].reason).toBe("tested-by");
  });

  it("explicitly planned nodes are never candidates", () => {
    const nodes = [node("a"), node("t", { isTest: true, file: "t.test.ts" })];
    const flows = [flow(1, ["a"])];
    const edges: TestEdge[] = [{ productionStableId: "a", testStableId: "t" }];
    const attached = deriveAttachments([flowUnit("a"), orphanUnit(["t"])], flows, nodes, edges, new Map());
    expect(attached.flat()).toEqual([]);
  });

  it("orphan-unit members can be parents too", () => {
    const nodes = [node("helper"), node("helper (module scope)", { file: "helper.ts" })];
    const [attached] = deriveAttachments([orphanUnit(["helper"])], [], nodes, [], new Map());
    expect(attached).toEqual([
      { stableId: "helper (module scope)", parentStableId: "helper", reason: "same-file", counted: true },
    ]);
  });
});

describe("countedAttachmentIds", () => {
  it("collects counted ids only", () => {
    const ids = countedAttachmentIds([
      [{ stableId: "t", parentStableId: "a", reason: "tested-by", counted: true }],
      [{ stableId: "t", parentStableId: "b", reason: "tested-by", counted: false }],
    ]);
    expect([...ids]).toEqual(["t"]);
  });
});
