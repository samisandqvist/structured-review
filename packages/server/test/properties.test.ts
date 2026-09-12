import fc, { type Parameters } from "fast-check";
import { describe, expect, it } from "vitest";

import { computeCoverage, type PlanUnitInput } from "../src/coverage.js";
import { subtractRanges } from "../src/diff.js";
import { matchGlob, resolveOrphanFiles } from "../src/globs.js";
import type { Flow } from "../src/graph/provider.js";
import type { LineRange } from "../src/types.js";

const propertyParameters = (seed: number, pathVariable: string): Parameters<unknown[]> => {
  const path = process.env[pathVariable];
  return { seed, numRuns: 250, endOnFailure: true, ...(path ? { path } : {}) };
};

const id = (value: number) => `id:${value}`;
const sorted = (values: Iterable<string>) => [...values].sort();

const flowSpecArbitrary = fc.record({
  entry: fc.integer({ min: 0, max: 15 }),
  body: fc.array(fc.integer({ min: 0, max: 15 }), { maxLength: 10 }),
});

const unitSpecArbitrary = fc.oneof(
  fc.record({
    kind: fc.constant("flow" as const),
    entries: fc.array(fc.integer({ min: 0, max: 18 }), { maxLength: 8 }),
  }),
  fc.record({
    kind: fc.constant("orphans" as const),
    members: fc.array(fc.integer({ min: 0, max: 18 }), { maxLength: 10 }),
  }),
);

const coverageScenarioArbitrary = fc.record({
  changed: fc.uniqueArray(fc.integer({ min: 0, max: 15 }), { maxLength: 16 }),
  flowSpecs: fc.uniqueArray(flowSpecArbitrary, { selector: (flow) => flow.entry, maxLength: 6 }),
  unitSpecs: fc.array(unitSpecArbitrary, { maxLength: 10 }),
});

function makeFlow(spec: { entry: number; body: number[] }, index: number): Flow {
  return {
    id: index,
    name: `flow-${index}`,
    criticality: 0,
    depth: 0,
    steps: [spec.entry, ...spec.body].map((value, depth) => ({
      stableId: id(value),
      label: id(value),
      file: `src/${value}.ts`,
      startLine: value + 1,
      endLine: value + 1,
      isTest: false,
      depth,
    })),
  };
}

function makeUnit(
  spec: { kind: "flow"; entries: number[] } | { kind: "orphans"; members: number[] },
  index: number,
): PlanUnitInput {
  return spec.kind === "flow"
    ? { kind: "flow", label: `flow-unit-${index}`, flowEntryStableIds: spec.entries.map(id) }
    : { kind: "orphans", label: `orphan-unit-${index}`, orphanStableIds: spec.members.map(id) };
}

function coverageOracle(units: PlanUnitInput[], flows: Flow[], changedIds: string[]): Set<string> {
  const selectedEntries = new Set(
    units.flatMap((unit) =>
      unit.kind === "flow"
        ? [...(unit.flowEntryStableIds ?? []), ...(unit.flowEntryStableId ? [unit.flowEntryStableId] : [])]
        : [],
    ),
  );
  const explicitMembers = units.flatMap((unit) => (unit.kind === "orphans" ? (unit.orphanStableIds ?? []) : []));
  const flowMembers = flows
    .filter((flow) => selectedEntries.has(flow.steps[0]?.stableId ?? ""))
    .flatMap((flow) => flow.steps.map((step) => step.stableId));
  const claimed = new Set([...explicitMembers, ...flowMembers]);
  return new Set(changedIds.filter((stableId) => claimed.has(stableId)));
}

function duplicateClaims(unit: PlanUnitInput): PlanUnitInput {
  if (unit.kind === "flow") {
    const entries = unit.flowEntryStableIds ?? [];
    return { ...unit, flowEntryStableIds: [...entries, ...entries] };
  }
  const members = unit.orphanStableIds ?? [];
  return { ...unit, orphanStableIds: [...members, ...members] };
}

function expandRanges(ranges: LineRange[]): Set<number> {
  const lines = new Set<number>();
  for (const range of ranges) for (let line = range.start; line <= range.end; line++) lines.add(line);
  return lines;
}

const rangeArbitrary = fc
  .tuple(fc.integer({ min: 0, max: 24 }), fc.integer({ min: 0, max: 24 }))
  .map(([a, b]): LineRange => ({ start: Math.min(a, b), end: Math.max(a, b) }));

const FILES = [
  "src/a.ts",
  "src/b.test.ts",
  "src/nested/c.ts",
  "test/a.test.ts",
  "docs/readme.md",
  ".github/workflows/ci.yml",
  ".env.example",
] as const;
const GLOBS = ["**/*.ts", "src/**", "**/*.test.ts", "test/*", "docs/**", ".github/**", ".env*", "**"] as const;

describe("generated coverage invariants", () => {
  it("coverage is exhaustive, contains no invented IDs, and ignores duplicate or reordered claims", () => {
    fc.assert(
      fc.property(coverageScenarioArbitrary, ({ changed, flowSpecs, unitSpecs }) => {
        const changedIds = changed.map(id);
        const flows = flowSpecs.map(makeFlow);
        const units = unitSpecs.map(makeUnit);
        const expectedCovered = coverageOracle(units, flows, changedIds);
        const expectedUnassigned = new Set(changedIds.filter((stableId) => !expectedCovered.has(stableId)));

        const actual = computeCoverage(units, flows, changedIds);
        expect(sorted(actual.covered)).toEqual(sorted(expectedCovered));
        expect(sorted(actual.unassigned)).toEqual(sorted(expectedUnassigned));
        expect(new Set([...actual.covered, ...actual.unassigned])).toEqual(new Set(changedIds));
        expect(actual.covered.every((stableId) => changedIds.includes(stableId))).toBe(true);
        expect(actual.unassigned.every((stableId) => changedIds.includes(stableId))).toBe(true);
        expect(new Set(actual.covered).size).toBe(actual.covered.length);
        expect(new Set(actual.unassigned).size).toBe(actual.unassigned.length);

        const reorderedUnits = [...units].reverse().map(duplicateClaims);
        const reorderedFlows = [...flows].reverse().map((flow) => ({
          ...flow,
          steps: [flow.steps[0], ...flow.steps.slice(1).reverse(), ...flow.steps.slice(1)].filter(
            (step): step is Flow["steps"][number] => step !== undefined,
          ),
        }));
        const repeated = computeCoverage(
          [...reorderedUnits, ...reorderedUnits],
          reorderedFlows,
          [...changedIds].reverse(),
        );
        expect(sorted(repeated.covered)).toEqual(sorted(expectedCovered));
        expect(sorted(repeated.unassigned)).toEqual(sorted(expectedUnassigned));
      }),
      propertyParameters(2026091201, "SREV_FC_COVERAGE_PATH"),
    );
  });
});

describe("generated range invariants", () => {
  it("subtractRanges matches an independent set-of-lines subtraction oracle", () => {
    fc.assert(
      fc.property(
        fc.array(rangeArbitrary, { maxLength: 8 }),
        fc.array(rangeArbitrary, { maxLength: 8 }),
        (ranges, spans) => {
          const expected = expandRanges(ranges);
          for (const line of expandRanges(spans)) expected.delete(line);

          const actual = subtractRanges(ranges, spans);
          expect(expandRanges(actual)).toEqual(expected);
          expect(actual.every((range) => range.start <= range.end)).toBe(true);
          expect(expandRanges(subtractRanges(ranges, [...spans].reverse()))).toEqual(expected);
        },
      ),
      propertyParameters(2026091202, "SREV_FC_RANGES_PATH"),
    );
  });
});

describe("generated glob invariants", () => {
  it("overlapping orphan globs assign each node at most once and never override explicit claims", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...FILES), { maxLength: FILES.length }),
        fc.array(fc.array(fc.constantFrom(...GLOBS), { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 6 }),
        fc.array(fc.integer({ min: -1, max: 12 }), { maxLength: FILES.length }),
        (files, globGroups, rawOwners) => {
          const nodes = files.map((file, index) => ({ stableId: `orphan:${index}`, file }));
          const explicitOwnerById = new Map<string, number>();
          nodes.forEach((node, index) => {
            const rawOwner = rawOwners[index] ?? -1;
            if (rawOwner >= 0) explicitOwnerById.set(node.stableId, rawOwner % globGroups.length);
          });
          const units: PlanUnitInput[] = globGroups.map((orphanFiles, unitIndex) => ({
            kind: "orphans",
            label: `unit-${unitIndex}`,
            orphanFiles,
            orphanStableIds: nodes
              .filter((node) => explicitOwnerById.get(node.stableId) === unitIndex)
              .map((node) => node.stableId),
          }));

          const { units: resolved } = resolveOrphanFiles(units, nodes);
          const assignments = resolved.flatMap((unit, unitIndex) =>
            unit.kind === "orphans" ? (unit.orphanStableIds ?? []).map((stableId) => ({ stableId, unitIndex })) : [],
          );
          expect(new Set(assignments.map(({ stableId }) => stableId)).size).toBe(assignments.length);
          expect(assignments.every(({ stableId }) => nodes.some((node) => node.stableId === stableId))).toBe(true);
          for (const [stableId, unitIndex] of explicitOwnerById) {
            expect(assignments.find((assignment) => assignment.stableId === stableId)?.unitIndex).toBe(unitIndex);
          }
          for (const node of nodes.filter((candidate) => !explicitOwnerById.has(candidate.stableId))) {
            const expectedUnit = globGroups.findIndex((globs) => globs.some((glob) => matchGlob(node.file, glob)));
            const actualUnit = assignments.find((assignment) => assignment.stableId === node.stableId)?.unitIndex ?? -1;
            expect(actualUnit).toBe(expectedUnit);
          }
        },
      ),
      propertyParameters(2026091203, "SREV_FC_GLOBS_PATH"),
    );
  });
});
