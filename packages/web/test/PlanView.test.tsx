import { render, screen, fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import { PlanView } from "../src/components/PlanView.js";

vi.mock("../src/api/hooks.js", () => ({
  useSession: () => ({ data: { units: [
    { id: "u1", position: 0, kind: "flow", label: "Order handling", rationale: "the order path", memberStableIds: ["fn:handleOrder"], auto: false },
    { id: "u2", position: 1, kind: "orphans", label: "Validation helpers", rationale: "", memberStableIds: ["fn:validateOrder"], auto: false },
    { id: "u3", position: 2, kind: "orphans", label: "Unassigned changes", rationale: "", memberStableIds: ["fn:lonely"], auto: true },
    { id: "u4", position: 3, kind: "flow", label: "Merged unit", rationale: "", memberStableIds: ["fn:entryA", "fn:entryB"], auto: false },
  ], coverage: { changedTotal: 3, covered: 2, unassigned: 1 } } }),
  useFlows: () => ({ data: { flows: [
    { id: 1, name: "handleOrder", criticality: 1, depth: 1, affected: true, entryStableId: "fn:handleOrder",
      changedStableIds: ["fn:handleOrder", "fn:processOrder"],
      steps: [
        { stableId: "fn:handleOrder", label: "handleOrder", file: "o.ts", startLine: 1, endLine: 2, isTest: false, depth: 0, nodeId: "n1", changeStatus: "changed", reviewStatus: "unreviewed" },
        { stableId: "fn:ctx1", label: "ctxHelperOne", file: "c.ts", startLine: 1, endLine: 2, isTest: false, depth: 1, offPath: true, nodeId: null, changeStatus: null, reviewStatus: null },
        { stableId: "fn:ctx2", label: "ctxHelperTwo", file: "c.ts", startLine: 5, endLine: 6, isTest: false, depth: 1, offPath: true, nodeId: null, changeStatus: null, reviewStatus: null },
        { stableId: "fn:processOrder", label: "processOrder", file: "o.ts", startLine: 10, endLine: 20, isTest: false, depth: 1, nodeId: "n4", changeStatus: "changed", reviewStatus: "reviewed-clean" },
      ] },
    { id: 2, name: "flow A", criticality: 0.5, depth: 1, affected: true, entryStableId: "fn:entryA",
      changedStableIds: ["fn:entryA", "fn:shared"],
      steps: [
        { stableId: "fn:entryA", label: "entryA", file: "a.ts", startLine: 1, endLine: 2, isTest: false, depth: 0, nodeId: "n5", changeStatus: "changed", reviewStatus: "unreviewed" },
        { stableId: "fn:shared", label: "sharedHelper", file: "s.ts", startLine: 1, endLine: 2, isTest: false, depth: 1, nodeId: "n6", changeStatus: "changed", reviewStatus: "reviewed-clean" },
      ] },
    { id: 3, name: "flow B", criticality: 0.4, depth: 1, affected: true, entryStableId: "fn:entryB",
      changedStableIds: ["fn:entryB", "fn:shared"],
      steps: [
        { stableId: "fn:entryB", label: "entryB", file: "b.ts", startLine: 1, endLine: 2, isTest: false, depth: 0, nodeId: "n7", changeStatus: "changed", reviewStatus: "unreviewed" },
        { stableId: "fn:shared", label: "sharedHelper", file: "s.ts", startLine: 1, endLine: 2, isTest: false, depth: 1, nodeId: "n6", changeStatus: "changed", reviewStatus: "reviewed-clean" },
      ] },
  ], orphans: [] } }),
  useNodes: () => ({ data: { nodes: [
    { id: "n2", stableId: "fn:validateOrder", label: "validateOrder", file: "o.ts", startLine: 3, endLine: 4, changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null, isTest: false },
    { id: "n3", stableId: "fn:lonely", label: "lonely", file: "x.ts", startLine: 1, endLine: 2, changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null, isTest: false },
  ] } }),
}));

describe("PlanView", () => {
  it("renders units in order with flow track, orphan chips, and an unassigned warning", () => {
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(headings).toEqual(["Order handling", "Validation helpers", "Unassigned changes", "Merged unit"]);
    expect(screen.getByText("handleOrder")).toBeInTheDocument();   // flow track step
    expect(screen.getByText("validateOrder")).toBeInTheDocument(); // orphan chip
    expect(screen.getByText("Unassigned changes").closest(".unit")).toHaveClass("unit--auto");
  });

  it("shows flow-unit progress over changed steps, not memberStableIds", () => {
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    // The flow has 2 changed steps (entry unreviewed, callee reviewed-clean) → 1/2
    const orderUnit = screen.getByText("Order handling").closest(".unit")!;
    const progress = orderUnit.querySelector(".unit__progress");
    expect(progress).not.toBeNull();
    expect(progress!.textContent).toBe("1/2");
  });

  it("collapses consecutive off-path steps into an expandable run", () => {
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    expect(screen.getByText("⋯ 2 unchanged calls")).toBeInTheDocument();
    expect(screen.queryByText("ctxHelperOne")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("⋯ 2 unchanged calls"));
    expect(screen.getByText("ctxHelperOne")).toBeInTheDocument();
    expect(screen.getByText("ctxHelperTwo")).toBeInTheDocument();
  });

  it("renders one track per entry of a multi-entry flow-unit and dedupes progress", () => {
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    const merged = screen.getByText("Merged unit").closest(".unit")!;
    // captions for both tracks
    expect(screen.getByText("flow A")).toBeInTheDocument();
    expect(screen.getByText("flow B")).toBeInTheDocument();
    // shared step rendered in both tracks
    expect(screen.getAllByText("sharedHelper")).toHaveLength(2);
    // distinct changed: entryA, entryB, shared = 3; reviewed: shared = 1
    expect(merged.querySelector(".unit__progress")!.textContent).toBe("1/3");
  });
});
