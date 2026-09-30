// Glob membership around attachment (plan-membership.ts): a directory glob later
// in the plan must not take a test away from the unit holding its subject.
import { describe, it, expect } from "vitest";
import { deriveAttachments, type AttachNode, type TestEdge } from "../src/attach.js";
import type { PlanUnitInput } from "../src/coverage.js";
import { resolvePlanMembership } from "../src/plan-membership.js";

const prod = (stableId: string, file: string): AttachNode => ({
  stableId,
  file,
  isTest: false,
  changeStatus: "changed",
});
const test = (stableId: string, file: string): AttachNode => ({ ...prod(stableId, file), isTest: true });
const globUnit = (label: string, orphanFiles: string[]): PlanUnitInput => ({ kind: "orphans", label, orphanFiles });

/** Real attachment over no flows and no file-requires, so only test edges and same-file rules apply. */
function membership(units: PlanUnitInput[], nodes: AttachNode[], edges: TestEdge[]) {
  return resolvePlanMembership(units, nodes, (resolved) => deriveAttachments(resolved, [], nodes, edges, new Map()));
}

describe("resolvePlanMembership", () => {
  const redact = prod("redact", "src/store/redact.ts");
  const match = prod("match", "src/store/match.ts");
  const redactTest = test("redact.test", "src/store/redact.test.ts");

  it("a later directory glob does not take a test away from the unit holding its subject", () => {
    const { units, attachedPerUnit, emptyUnits } = membership(
      [globUnit("redaction", ["src/store/redact.ts"]), globUnit("rest of store", ["src/store/**"])],
      [redact, match, redactTest],
      [{ productionStableId: "redact", testStableId: "redact.test" }],
    );
    expect(attachedPerUnit[0]).toEqual([
      { stableId: "redact.test", parentStableId: "redact", reason: "tested-by", counted: true },
    ]);
    expect(units[1]).toMatchObject({ orphanStableIds: ["match"] });
    expect(emptyUnits).toEqual([]);
  });

  it("a test that attaches nowhere is still placed by the first glob that matches it", () => {
    const orphanTest = test("orphan.test", "src/store/orphan.test.ts");
    const { units, attachedPerUnit } = membership(
      [globUnit("redaction", ["src/store/redact.ts"]), globUnit("rest of store", ["src/store/**"])],
      [redact, orphanTest],
      [],
    );
    expect(attachedPerUnit.flat()).toEqual([]);
    expect(units[1]).toMatchObject({ orphanStableIds: ["orphan.test"] });
  });

  it("an explicitly listed test stays an explicit member, never an attachment", () => {
    const { units, attachedPerUnit } = membership(
      [
        globUnit("redaction", ["src/store/redact.ts"]),
        { kind: "orphans", label: "picked tests", orphanStableIds: ["redact.test"] },
      ],
      [redact, redactTest],
      [{ productionStableId: "redact", testStableId: "redact.test" }],
    );
    expect(attachedPerUnit.flat()).toEqual([]);
    expect(units[1]).toMatchObject({ orphanStableIds: ["redact.test"] });
  });

  it("reports a glob unit left empty because every test it matched attached elsewhere", () => {
    const { emptyUnits } = membership(
      [globUnit("redaction", ["src/store/redact.ts"]), globUnit("tests only", ["src/**/*.test.ts"])],
      [redact, redactTest],
      [{ productionStableId: "redact", testStableId: "redact.test" }],
    );
    expect(emptyUnits).toEqual(["tests only"]);
  });
});
