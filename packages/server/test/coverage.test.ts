import { computeCoverage, flowEntries, unitCoverage, type PlanUnitInput } from "../src/coverage.js";
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

describe("flowEntries", () => {
  it("normalizes singular, plural, and both, deduped", () => {
    expect(flowEntries({ kind: "flow", flowEntryStableId: "a", label: "" })).toEqual(["a"]);
    expect(flowEntries({ kind: "flow", flowEntryStableIds: ["a", "b", "a"], label: "" })).toEqual(["a", "b"]);
    expect(flowEntries({ kind: "flow", flowEntryStableIds: ["a"], flowEntryStableId: "a", label: "" })).toEqual(["a"]);
    expect(flowEntries({ kind: "orphans", orphanStableIds: ["x"], label: "" })).toEqual([]);
  });
});

describe("multi-entry unitCoverage", () => {
  const mkFlow = (id: number, entry: string, rest: string[]): Flow => ({
    id, name: entry, criticality: 0, depth: 1,
    steps: [step(entry), ...rest.map((s) => step(s, 1))],
  });
  it("unions changed steps across entries, counting shared nodes once", () => {
    const fs = [mkFlow(1, "e1", ["c1", "shared"]), mkFlow(2, "e2", ["c2", "shared"])];
    const changed = new Set(["c1", "c2", "shared"]);
    const unit: PlanUnitInput = { kind: "flow", flowEntryStableIds: ["e1", "e2"], label: "merged" };
    expect(unitCoverage(unit, fs, changed).sort()).toEqual(["c1", "c2", "shared"]);
  });
  it("an entry matching no flow contributes nothing", () => {
    const fs = [mkFlow(1, "e1", ["c1"])];
    const unit: PlanUnitInput = { kind: "flow", flowEntryStableIds: ["e1", "missing"], label: "m" };
    expect(unitCoverage(unit, fs, new Set(["c1"]))).toEqual(["c1"]);
  });
});
