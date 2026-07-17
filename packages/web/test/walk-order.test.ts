import { describe, it, expect } from "vitest";
import { buildWalkOrder, nextInWalk, nextUnreviewed } from "../src/walk-order.js";
import type { Unit, Flow, Node, FlowStep } from "../src/api/client.js";

const node = (id: string, review = "unreviewed"): Node => ({
  id: `n-${id}`, sessionId: "s", stableId: id, label: id, file: "f.ts", startLine: 1, endLine: 2,
  changeStatus: "changed", reviewStatus: review as Node["reviewStatus"], reviewedInUnit: null, isTest: false,
});
const step = (id: string, changed = true): FlowStep => ({
  stableId: id, label: id, file: "f.ts", startLine: 1, endLine: 2, isTest: false, depth: 0,
  nodeId: changed ? `n-${id}` : null, changeStatus: changed ? "changed" : null, reviewStatus: null,
});
const unit = (
  id: string, kind: "flow" | "orphans", members: string[], position: number,
  attached: Unit["attached"] = []
): Unit => ({
  id, sessionId: "s", position, label: id, rationale: "", kind, memberStableIds: members, auto: false, attached,
});

describe("buildWalkOrder", () => {
  it("orders units by position, flows in step order, orphans in member order, deduped", () => {
    const flows: Flow[] = [{
      id: 1, name: "f", criticality: 0, depth: 1, affected: true, entryStableId: "e",
      changedStableIds: ["e", "shared"],
      steps: [step("e"), step("shared"), step("ctx", false)],
    }];
    const units = [unit("u2", "orphans", ["shared", "orphan1"], 1), unit("u1", "flow", ["e"], 0)];
    const nodes = [node("e"), node("shared"), node("orphan1")];
    expect(buildWalkOrder(units, flows, nodes).map((w) => w.stableId)).toEqual(["e", "shared", "orphan1"]);
  });

  it("walks counted attachments right after their parent; references never walk", () => {
    const flows: Flow[] = [{
      id: 1, name: "f", criticality: 0, depth: 1, affected: true, entryStableId: "e",
      changedStableIds: ["e", "next"],
      steps: [step("e"), step("next")],
    }];
    const units = [
      unit("u1", "flow", ["e"], 0, [
        { stableId: "t", parentStableId: "e", reason: "tested-by", counted: true },
      ]),
      unit("u2", "orphans", ["orphan1"], 1, [
        { stableId: "t", parentStableId: "orphan1", reason: "tested-by", counted: false },
        { stableId: "dto", parentStableId: "orphan1", reason: "required-by", counted: true },
      ]),
    ];
    const nodes = [node("e"), node("next"), node("t"), node("orphan1"), node("dto")];
    expect(buildWalkOrder(units, flows, nodes).map((w) => w.stableId)).toEqual([
      "e", "t", "next", "orphan1", "dto",
    ]);
  });
});

describe("navigation", () => {
  const order = [
    { nodeId: "n-a", stableId: "a" },
    { nodeId: "n-b", stableId: "b" },
    { nodeId: "n-c", stableId: "c" },
  ];
  it("nextInWalk steps and wraps", () => {
    expect(nextInWalk(order, "n-a", 1)).toBe("n-b");
    expect(nextInWalk(order, "n-c", 1)).toBe("n-a");
    expect(nextInWalk(order, "n-a", -1)).toBe("n-c");
    expect(nextInWalk(order, null, 1)).toBe("n-a");
    expect(nextInWalk([], null, 1)).toBeNull();
  });
  it("nextUnreviewed skips reviewed nodes and wraps past current", () => {
    const nodes = [node("a", "reviewed-clean"), node("b", "reviewed-clean"), node("c")];
    expect(nextUnreviewed(order, nodes, "n-a")).toBe("n-c");
    const allDone = [node("a", "reviewed-clean"), node("b", "reviewed-clean"), node("c", "reviewed-commented")];
    expect(nextUnreviewed(order, allDone, "n-a")).toBeNull();
  });
});
