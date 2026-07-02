import { computeCoverage, type PlanUnitInput } from "../src/coverage.js";
import type { Flow } from "../src/graph/provider.js";

const step = (stableId: string, depth = 0) => ({
  stableId, label: stableId, file: "f.ts", startLine: 1, endLine: 2, isTest: false, depth,
});
const flows: Flow[] = [
  { id: 1, name: "handleOrder", criticality: 1, depth: 1, steps: [step("fn:handleOrder"), step("fn:validateOrder", 1)] },
];

describe("computeCoverage", () => {
  it("covers changed steps of a flow-unit by entry stableId", () => {
    const units: PlanUnitInput[] = [{ kind: "flow", flowEntryStableId: "fn:handleOrder", label: "Order" }];
    const r = computeCoverage(units, flows, ["fn:handleOrder", "fn:validateOrder", "fn:lonely"]);
    expect(r.covered.sort()).toEqual(["fn:handleOrder", "fn:validateOrder"]);
    expect(r.unassigned).toEqual(["fn:lonely"]);
  });

  it("covers orphan-unit members and reports the rest unassigned", () => {
    const units: PlanUnitInput[] = [{ kind: "orphans", orphanStableIds: ["fn:lonely"], label: "Other" }];
    const r = computeCoverage(units, flows, ["fn:handleOrder", "fn:lonely"]);
    expect(r.covered).toEqual(["fn:lonely"]);
    expect(r.unassigned).toEqual(["fn:handleOrder"]);
  });

  it("ignores a flow-unit whose entry matches no flow", () => {
    const units: PlanUnitInput[] = [{ kind: "flow", flowEntryStableId: "fn:ghost", label: "Ghost" }];
    const r = computeCoverage(units, flows, ["fn:handleOrder"]);
    expect(r.covered).toEqual([]);
    expect(r.unassigned).toEqual(["fn:handleOrder"]);
  });
});
