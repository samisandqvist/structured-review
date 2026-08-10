// Derivation passes for plan-time attachments (attach.ts).
import { describe, it, expect } from "vitest";
import { deriveAttachments, countedAttachmentIds, orphanWalkIds, type AttachNode, type TestEdge } from "../src/attach.js";
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

/** requires-map literal: [consumer, defFile, hasValueRef?][] (value ref unless stated). */
function req(edges: [string, string, boolean?][]): Map<string, Map<string, { hasValueRef: boolean }>> {
  const m = new Map<string, Map<string, { hasValueRef: boolean }>>();
  for (const [from, to, value = true] of edges) {
    (m.get(from) ?? m.set(from, new Map()).get(from)!).set(to, { hasValueRef: value });
  }
  return m;
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
    const requires = req([["ctrl.ts", "dto.ts", false]]); // type-only: pass 3 attaches regardless
    const [attached] = deriveAttachments([flowUnit("ctrl")], flows, nodes, [], requires);
    expect(attached).toEqual([{ stableId: "dto", parentStableId: "ctrl", reason: "required-by", counted: true }]);
  });

  it("no consumer covered -> stays unattached (no chaining through attachments)", () => {
    // t (attached test) is in t.test.ts which requires dto.ts — but t is an
    // attachment, not a covered node, so dto must not chain onto it.
    const nodes = [node("a"), node("t", { isTest: true, file: "t.test.ts" }), node("dto", { file: "dto.ts" })];
    const flows = [flow(1, ["a"])];
    const edges: TestEdge[] = [{ productionStableId: "a", testStableId: "t" }];
    const requires = req([["t.test.ts", "dto.ts"]]);
    const attached = deriveAttachments([flowUnit("a")], flows, nodes, edges, requires);
    expect(attached.flat()).toEqual([{ stableId: "t", parentStableId: "a", reason: "tested-by", counted: true }]);
  });
});

describe("deriveAttachments — test imports (pass 4)", () => {
  it("nests an edge-less test under the first covered node its file imports", () => {
    const nodes = [node("a"), node("helper", { isTest: true, file: "a.test.ts" })];
    const flows = [flow(1, ["a"])];
    // No TESTED_BY edge (vitest anonymous callbacks) — but a.test.ts imports a.ts.
    const requires = req([["a.test.ts", "a.ts"]]);
    const [attached] = deriveAttachments([flowUnit("a")], flows, nodes, [], requires);
    expect(attached).toEqual([{ stableId: "helper", parentStableId: "a", reason: "tested-by", counted: true }]);
  });

  it("does not apply the import direction to production nodes", () => {
    const nodes = [node("a"), node("consumer", { file: "consumer.ts" })];
    const flows = [flow(1, ["a"])];
    // consumer.ts imports a.ts, but consumer is not a test: evidence too weak.
    const requires = req([["consumer.ts", "a.ts"]]);
    const attached = deriveAttachments([flowUnit("a")], flows, nodes, [], requires);
    expect(attached.flat()).toEqual([]);
  });

  it("prefers the covered node whose file basename matches the spec name over an earlier hub import", () => {
    // Issue #11: every spec imported the schema hub (fixture types), and the
    // schema sat in an early orphan unit — walk order made it a test magnet.
    const nodes = [
      node("schema", { file: "src/database/schema.ts" }),
      node("svc", { file: "src/users/users.service.ts" }),
      node("spec", { isTest: true, file: "src/users/users.service.spec.ts" }),
    ];
    const flows = [flow(1, ["svc"])];
    // Both edges are value refs on purpose: basename ranking must win on its
    // own, without help from the type-only filter.
    const requires = req([
      ["src/users/users.service.spec.ts", "src/database/schema.ts"],
      ["src/users/users.service.spec.ts", "src/users/users.service.ts"],
    ]);
    const attached = deriveAttachments(
      [orphanUnit(["schema"], "Database schema"), flowUnit("svc")],
      flows, nodes, [], requires
    );
    expect(attached[0]).toEqual([]);
    expect(attached[1]).toEqual([{ stableId: "spec", parentStableId: "svc", reason: "tested-by", counted: true }]);
  });

  it("basename match understands prefix (python) and suffix (java) test naming", () => {
    const cases = [
      { testFile: "tests/test_users.py", subjectFile: "app/users.py" },
      { testFile: "src/test/UsersServiceTest.java", subjectFile: "src/main/UsersService.java" },
    ];
    for (const { testFile, subjectFile } of cases) {
      const nodes = [
        node("hub", { file: "src/hub.py" }),
        node("subject", { file: subjectFile }),
        node("t", { isTest: true, file: testFile }),
      ];
      const flows = [flow(1, ["subject"])];
      const requires = req([[testFile, "src/hub.py"], [testFile, subjectFile]]);
      const attached = deriveAttachments(
        [orphanUnit(["hub"]), flowUnit("subject")],
        flows, nodes, [], requires
      );
      expect(attached[1], testFile).toEqual([{ stableId: "t", parentStableId: "subject", reason: "tested-by", counted: true }]);
    }
  });

  it("falls back to walk order when no basename matches", () => {
    const nodes = [
      node("a", { file: "src/a.ts" }),
      node("b", { file: "src/b.ts" }),
      node("t", { isTest: true, file: "src/misc.spec.ts" }),
    ];
    const flows = [flow(1, ["a", "b"])];
    const requires = req([["src/misc.spec.ts", "src/a.ts"], ["src/misc.spec.ts", "src/b.ts"]]);
    const [attached] = deriveAttachments([flowUnit("a")], flows, nodes, [], requires);
    expect(attached).toEqual([{ stableId: "t", parentStableId: "a", reason: "tested-by", counted: true }]);
  });

  it("prefers a real TESTED_BY edge over imports", () => {
    const nodes = [node("a"), node("b"), node("t", { isTest: true, file: "t.test.ts" })];
    const flows = [flow(1, ["a", "b"])];
    const edges: TestEdge[] = [{ productionStableId: "b", testStableId: "t" }];
    const requires = req([["t.test.ts", "a.ts"]]); // imports point at a
    const [attached] = deriveAttachments([flowUnit("a")], flows, nodes, edges, requires);
    expect(attached).toEqual([{ stableId: "t", parentStableId: "b", reason: "tested-by", counted: true }]);
  });
});

describe("deriveAttachments — value vs type-only imports (pass 4)", () => {
  it("ignores a type-only hub import even without a basename match", () => {
    // Issue #12: `import type { User } from '../database/schema'` in a guard
    // spec says nothing about what the spec exercises.
    const nodes = [
      node("schema", { file: "src/database/schema.ts" }),
      node("guard", { file: "src/auth/admin-role.guard.ts" }),
      node("spec", { isTest: true, file: "src/auth/guards.spec.ts" }),
    ];
    const flows = [flow(1, ["guard"])];
    const requires = req([
      ["src/auth/guards.spec.ts", "src/database/schema.ts", false],
      ["src/auth/guards.spec.ts", "src/auth/admin-role.guard.ts", true],
    ]);
    const attached = deriveAttachments([orphanUnit(["schema"]), flowUnit("guard")], flows, nodes, [], requires);
    expect(attached[0]).toEqual([]);
    expect(attached[1]).toEqual([{ stableId: "spec", parentStableId: "guard", reason: "tested-by", counted: true }]);
  });

  it("a spec with only type-only imports stays unattached", () => {
    const nodes = [
      node("schema", { file: "src/database/schema.ts" }),
      node("spec", { isTest: true, file: "src/misc.spec.ts" }),
    ];
    const flows = [flow(1, ["schema"])];
    const requires = req([["src/misc.spec.ts", "src/database/schema.ts", false]]);
    const attached = deriveAttachments([flowUnit("schema")], flows, nodes, [], requires);
    expect(attached.flat()).toEqual([]);
  });

  it("a type-only import still counts when the basename matches (type-test specs)", () => {
    const nodes = [
      node("schema", { file: "src/database/schema.ts" }),
      node("spec", { isTest: true, file: "src/database/schema.spec.ts" }),
    ];
    const flows = [flow(1, ["schema"])];
    const requires = req([["src/database/schema.spec.ts", "src/database/schema.ts", false]]);
    const [attached] = deriveAttachments([flowUnit("schema")], flows, nodes, [], requires);
    expect(attached).toEqual([{ stableId: "spec", parentStableId: "schema", reason: "tested-by", counted: true }]);
  });
});

describe("deriveAttachments — precedence and explicit membership", () => {
  it("tested-by wins over same-file and required-by", () => {
    const nodes = [node("a", { file: "shared.ts" }), node("t", { isTest: true, file: "shared.ts" })];
    const flows = [flow(1, ["a"])];
    const edges: TestEdge[] = [{ productionStableId: "a", testStableId: "t" }];
    const requires = req([["shared.ts", "shared.ts"]]);
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

describe("orphanWalkIds", () => {
  const byStable = (nodes: AttachNode[]) => new Map(nodes.map((n) => [n.stableId, n]));

  it("walks a residual member right after its file's function node", () => {
    const nodes = [
      node("file-residual:helper.ts", { file: "helper.ts", residualKind: "module-scope" }),
      node("fn:helper", { file: "helper.ts" }),
    ];
    expect(orphanWalkIds(["file-residual:helper.ts", "fn:helper"], byStable(nodes))).toEqual([
      "fn:helper", "file-residual:helper.ts",
    ]);
  });

  it("groups by directory in order of first appearance", () => {
    const nodes = [
      node("res:a", { file: "drizzle/0001.sql", residualKind: "whole-file" }),
      node("fn:svc", { file: "src/db/service.ts" }),
      node("res:b", { file: "drizzle/0002.sql", residualKind: "whole-file" }),
    ];
    expect(orphanWalkIds(["res:a", "fn:svc", "res:b"], byStable(nodes))).toEqual([
      "res:a", "res:b", "fn:svc",
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
