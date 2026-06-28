import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { PlanView } from "../src/components/PlanView.js";

vi.mock("../src/api/hooks.js", () => ({
  useSession: () => ({ data: { units: [
    { id: "u1", position: 0, kind: "flow", label: "Order handling", rationale: "the order path", memberStableIds: ["fn:handleOrder"], auto: false },
    { id: "u2", position: 1, kind: "orphans", label: "Validation helpers", rationale: "", memberStableIds: ["fn:validateOrder"], auto: false },
    { id: "u3", position: 2, kind: "orphans", label: "Unassigned changes", rationale: "", memberStableIds: ["fn:lonely"], auto: true },
  ], coverage: { changedTotal: 3, covered: 2, unassigned: 1 } } }),
  useFlows: () => ({ data: { flows: [
    { id: 1, name: "handleOrder", criticality: 1, depth: 1, affected: true, entryStableId: "fn:handleOrder",
      steps: [
        { label: "handleOrder", file: "o.ts", startLine: 1, endLine: 2, isTest: false, depth: 0, nodeId: "n1", changeStatus: "changed", reviewStatus: "unreviewed" },
        { label: "processOrder", file: "o.ts", startLine: 10, endLine: 20, isTest: false, depth: 1, nodeId: "n4", changeStatus: "changed", reviewStatus: "reviewed-clean" },
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
    expect(headings).toEqual(["Order handling", "Validation helpers", "Unassigned changes"]);
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
});
