// packages/skill/test/status.test.ts
import { describe, it, expect } from "vitest";
import { computeStatus, waitConditionMet } from "../src/status.js";
import type { FlowDTO, SessionInfo, SessionNode } from "../src/api.js";

function node(stableId: string, over: Partial<SessionNode> = {}): SessionNode {
  return {
    id: `id-${stableId}`,
    stableId,
    label: stableId,
    file: "f.ts",
    startLine: 1,
    endLine: 10,
    changeStatus: "changed",
    reviewStatus: "unreviewed",
    isTest: false,
    ...over,
  };
}

function flow(entry: string, stepIds: string[]): FlowDTO {
  return {
    id: 1,
    name: entry,
    affected: true,
    entryStableId: entry,
    changedStableIds: [],
    steps: stepIds.map((s, i) => ({
      stableId: s,
      label: s,
      file: "f.ts",
      startLine: 1,
      endLine: 10,
      isTest: false,
      depth: i,
      nodeId: `id-${s}`,
      changeStatus: null,
      reviewStatus: null,
    })),
  };
}

function info(units: SessionInfo["units"], extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    session: { id: "s1", branch: "b", baseRef: "main", status: "walking", createdAt: 0 },
    units,
    coverage: { changedTotal: 3, covered: 3, unassigned: 0 },
    ...extra,
  };
}

describe("computeStatus", () => {
  const nodes = [
    node("fn:a", { reviewStatus: "reviewed-clean" }),
    node("fn:b"),
    node("fn:c", { changeStatus: "unchanged", reviewStatus: "unreviewed" }),
    node("fn:orphan", { reviewStatus: "reviewed-commented" }),
  ];
  const flows = [flow("fn:a", ["fn:a", "fn:b", "fn:c"])];

  it("counts flow-unit progress over distinct changed steps of its flows", () => {
    const status = computeStatus(
      info([{ id: "u1", label: "Flow A", kind: "flow", memberStableIds: ["fn:a"], auto: false, attached: [] }]),
      nodes,
      flows,
    );
    // fn:c is unchanged, so total = a + b; only a is reviewed.
    expect(status.units[0]).toMatchObject({ label: "Flow A", reviewed: 1, total: 2 });
  });

  it("counts counted attachments in the unit ledger, ignores references", () => {
    const status = computeStatus(
      info([
        {
          id: "u1",
          label: "Flow A",
          kind: "flow",
          memberStableIds: ["fn:a"],
          auto: false,
          attached: [
            { stableId: "fn:orphan", parentStableId: "fn:a", reason: "tested-by", counted: true },
            { stableId: "fn:b", parentStableId: "fn:a", reason: "tested-by", counted: false },
          ],
        },
      ]),
      nodes,
      flows,
    );
    // base 1/2 + attached fn:orphan (reviewed-commented) = 2/3; the reference adds nothing.
    expect(status.units[0]).toMatchObject({ reviewed: 2, total: 3 });
  });

  it("counts orphan-unit progress over its changed members", () => {
    const status = computeStatus(
      info([
        {
          id: "u2",
          label: "Other",
          kind: "orphans",
          memberStableIds: ["fn:orphan", "fn:c"],
          auto: false,
          attached: [],
        },
      ]),
      nodes,
      flows,
    );
    expect(status.units[0]).toMatchObject({ reviewed: 1, total: 1 });
  });

  it("falls back to member nodes for a flow-unit whose flows did not resolve", () => {
    const status = computeStatus(
      info([{ id: "u3", label: "Ghost", kind: "flow", memberStableIds: ["fn:b"], auto: false, attached: [] }]),
      nodes,
      [], // no flows resolved
    );
    expect(status.units[0]).toMatchObject({ reviewed: 0, total: 1 });
  });

  it("lists changed unreviewed nodes and carries stale flags through", () => {
    const status = computeStatus(info([], { stale: true, staleReason: "head-moved" }), nodes, flows);
    expect(status.unreviewed.map((n) => n.stableId)).toEqual(["fn:b"]);
    expect(status.stale).toBe(true);
    expect(status.staleReason).toBe("head-moved");
  });

  it("includes the session overview only when non-empty", () => {
    const base = {
      units: [],
      coverage: { changedTotal: 0, covered: 0, unassigned: 0 },
    };
    const withOverview = computeStatus(
      {
        ...base,
        session: {
          id: "s1",
          branch: "b",
          baseRef: "main",
          status: "walking",
          createdAt: 0,
          overview: "Adds Redis rate limiting.",
        },
      },
      [],
      [],
    );
    expect(withOverview.overview).toBe("Adds Redis rate limiting.");

    const without = computeStatus(
      { ...base, session: { id: "s1", branch: "b", baseRef: "main", status: "walking", createdAt: 0, overview: "" } },
      [],
      [],
    );
    expect(without.overview).toBeUndefined();
  });
});

describe("waitConditionMet", () => {
  const base = {
    sessionId: "s1",
    sessionStatus: "walking",
    coverage: { changedTotal: 2, covered: 2, unassigned: 0 },
    units: [],
  };
  it("'reviewed' is met when no changed node is unreviewed", () => {
    expect(waitConditionMet("reviewed", { ...base, unreviewed: [] }, 0)).toBe(true);
    expect(waitConditionMet("reviewed", { ...base, unreviewed: [{ stableId: "x", label: "x", file: "f" }] }, 5)).toBe(
      false,
    );
  });
  it("'commented' is met when at least one comment exists", () => {
    expect(waitConditionMet("commented", { ...base, unreviewed: [] }, 0)).toBe(false);
    expect(waitConditionMet("commented", { ...base, unreviewed: [{ stableId: "x", label: "x", file: "f" }] }, 1)).toBe(
      true,
    );
  });
});
