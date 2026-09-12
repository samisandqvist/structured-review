import { render, screen, fireEvent } from "@testing-library/react";
import { vi, beforeEach } from "vitest";
import { PlanView } from "../src/components/PlanView.js";
import { useUIStore } from "../src/store/ui.js";

const mockBulkMutate = vi.fn();
const mockUpdateUnit = vi.fn();
let mockOverview = "";

vi.mock("../src/api/hooks.js", () => ({
  useBulkUpdateNodeStatus: () => ({ mutate: mockBulkMutate }),
  useUpdateUnit: () => ({ mutate: mockUpdateUnit }),
  useComments: () => ({ data: { comments: [] }, isLoading: false }),
  useCreateComment: () => ({ mutate: vi.fn() }),
  useSession: () => ({
    data: {
      session: { overview: mockOverview },
      units: [
        {
          id: "u1",
          position: 0,
          kind: "flow",
          label: "Order handling",
          rationale: "the order path",
          memberStableIds: ["fn:handleOrder"],
          auto: false,
          attached: [
            { stableId: "fn:testOrder", parentStableId: "fn:handleOrder", reason: "tested-by", counted: false },
          ],
        },
        {
          id: "u2",
          position: 1,
          kind: "orphans",
          label: "Validation helpers",
          rationale: "",
          memberStableIds: ["fn:validateOrder"],
          auto: false,
          attached: [
            { stableId: "fn:testOrder", parentStableId: "fn:validateOrder", reason: "tested-by", counted: true },
          ],
        },
        {
          id: "u3",
          position: 2,
          kind: "orphans",
          label: "Unassigned changes",
          rationale: "",
          memberStableIds: ["fn:lonely"],
          auto: true,
        },
        {
          id: "u4",
          position: 3,
          kind: "flow",
          label: "Merged unit",
          rationale: "",
          memberStableIds: ["fn:entryA", "fn:entryB"],
          auto: false,
        },
      ],
      coverage: { changedTotal: 3, covered: 2, unassigned: 1 },
    },
  }),
  useFlows: () => ({
    data: {
      flows: [
        {
          id: 1,
          name: "handleOrder",
          criticality: 1,
          depth: 1,
          affected: true,
          entryStableId: "fn:handleOrder",
          entryConfidence: 0.7,
          entryReasons: ["graph-root", "exported"],
          changedStableIds: ["fn:handleOrder", "fn:processOrder"],
          steps: [
            {
              stableId: "fn:handleOrder",
              label: "handleOrder",
              file: "o.ts",
              startLine: 1,
              endLine: 2,
              isTest: false,
              depth: 0,
              nodeId: "n1",
              changeStatus: "changed",
              reviewStatus: "unreviewed",
            },
            {
              stableId: "fn:ctx1",
              label: "ctxHelperOne",
              file: "c.ts",
              startLine: 1,
              endLine: 2,
              isTest: false,
              depth: 1,
              offPath: true,
              nodeId: null,
              changeStatus: null,
              reviewStatus: null,
            },
            {
              stableId: "fn:ctx2",
              label: "ctxHelperTwo",
              file: "c.ts",
              startLine: 5,
              endLine: 6,
              isTest: false,
              depth: 1,
              offPath: true,
              nodeId: null,
              changeStatus: null,
              reviewStatus: null,
            },
            {
              stableId: "fn:processOrder",
              label: "processOrder",
              file: "o.ts",
              startLine: 10,
              endLine: 20,
              isTest: false,
              depth: 1,
              nodeId: "n4",
              changeStatus: "changed",
              reviewStatus: "reviewed-commented",
            },
          ],
        },
        {
          id: 2,
          name: "flow A",
          criticality: 0.5,
          depth: 1,
          affected: true,
          entryStableId: "fn:entryA",
          entryConfidence: 0.4,
          entryReasons: ["graph-root"],
          changedStableIds: ["fn:entryA", "fn:shared"],
          steps: [
            {
              stableId: "fn:entryA",
              label: "entryA",
              file: "a.ts",
              startLine: 1,
              endLine: 2,
              isTest: false,
              depth: 0,
              nodeId: "n5",
              changeStatus: "changed",
              reviewStatus: "unreviewed",
            },
            {
              stableId: "fn:shared",
              label: "sharedHelper",
              file: "s.ts",
              startLine: 1,
              endLine: 2,
              isTest: false,
              depth: 1,
              nodeId: "n6",
              changeStatus: "changed",
              reviewStatus: "reviewed-clean",
            },
          ],
        },
        {
          id: 3,
          name: "flow B",
          criticality: 0.4,
          depth: 1,
          affected: true,
          entryStableId: "fn:entryB",
          entryConfidence: 0.4,
          entryReasons: ["graph-root"],
          changedStableIds: ["fn:entryB", "fn:shared"],
          steps: [
            {
              stableId: "fn:entryB",
              label: "entryB",
              file: "b.ts",
              startLine: 1,
              endLine: 2,
              isTest: false,
              depth: 0,
              nodeId: "n7",
              changeStatus: "changed",
              reviewStatus: "unreviewed",
            },
            {
              stableId: "fn:shared",
              label: "sharedHelper",
              file: "s.ts",
              startLine: 1,
              endLine: 2,
              isTest: false,
              depth: 1,
              nodeId: "n6",
              changeStatus: "changed",
              reviewStatus: "reviewed-clean",
            },
          ],
        },
      ],
      orphans: [],
    },
  }),
  useNodes: () => ({
    data: {
      nodes: [
        {
          id: "n2",
          stableId: "fn:validateOrder",
          label: "validateOrder",
          file: "o.ts",
          startLine: 3,
          endLine: 4,
          changeStatus: "changed",
          reviewStatus: "unreviewed",
          reviewedInUnit: null,
          isTest: false,
        },
        {
          id: "n3",
          stableId: "fn:lonely",
          label: "lonely",
          file: "x.ts",
          startLine: 1,
          endLine: 2,
          changeStatus: "changed",
          reviewStatus: "unreviewed",
          reviewedInUnit: null,
          isTest: false,
        },
        {
          id: "n-t1",
          stableId: "fn:testOrder",
          label: "testOrder",
          file: "o.test.ts",
          startLine: 1,
          endLine: 9,
          changeStatus: "changed",
          reviewStatus: "unreviewed",
          reviewedInUnit: null,
          isTest: true,
        },
        {
          id: "n-t2",
          stableId: "fn:testLegacy",
          label: "testLegacy",
          file: "o.test.ts",
          startLine: 12,
          endLine: 20,
          changeStatus: "unchanged",
          reviewStatus: "unreviewed",
          reviewedInUnit: null,
          isTest: true,
        },
      ],
      edges: [
        { sourceNodeId: "n1", targetNodeId: "n-t1", edgeType: "test" },
        { sourceNodeId: "n1", targetNodeId: "n-t2", edgeType: "test" },
        { sourceNodeId: "n2", targetNodeId: "n-t2", edgeType: "test" },
      ],
    },
  }),
}));

beforeEach(() => {
  mockBulkMutate.mockClear();
  mockUpdateUnit.mockClear();
  mockOverview = "";
  useUIStore.setState({ collapsedUnits: [], expandedUnits: [] });
});

describe("PlanView", () => {
  it("renders units in order with flow track, orphan chips, and an unassigned warning", () => {
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    expect(screen.getByRole("heading", { name: "Plan", level: 2 })).toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["Order handling", "Validation helpers", "Unassigned changes", "Merged unit"]);
    expect(screen.getByText("handleOrder")).toBeInTheDocument(); // flow track step
    expect(screen.getByText("validateOrder")).toBeInTheDocument(); // orphan chip
    expect(screen.getByText("Unassigned changes").closest(".unit")).toHaveClass("unit--auto");
  });

  it("marks commented nodes with ✱ so the reviewer can return to them", () => {
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    const marks = screen.getAllByTestId("comment-mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].closest("button")).toHaveTextContent("processOrder");
  });

  it("shows flow-unit progress over changed steps, not memberStableIds", () => {
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    // The flow has 2 changed steps (entry unreviewed, callee reviewed-clean) → 1/2
    const orderUnit = screen.getByText("Order handling").closest(".unit")!;
    const progress = orderUnit.querySelector(".unit__progress");
    expect(progress).not.toBeNull();
    expect(progress!.textContent).toBe("1/2");
  });

  it("renders a counted attachment in the unit, adds it to the ledger, and selects it on click", () => {
    const onSelect = vi.fn();
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={onSelect} />);
    // u2: 1 member (unreviewed) + 1 counted attached test (unreviewed) → 0/2
    const valUnit = screen.getByText("Validation helpers").closest(".unit")!;
    expect(valUnit.querySelector(".unit__progress")!.textContent).toBe("0/2");
    const member = screen.getByTestId("attached-member");
    expect(member.textContent).toContain("testOrder");
    expect(member.textContent).toContain("tested-by");
    fireEvent.click(member);
    expect(onSelect).toHaveBeenCalledWith("n-t1");
  });

  it("renders a cross-unit reference dimmed and keeps it out of the ledger", () => {
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    const ref = screen.getByTestId("attached-ref"); // u1: testOrder counts in u2, references here
    expect(ref.className).toContain("step--ref");
    // u1 progress stays 1/2 — the reference adds nothing.
    const orderUnit = screen.getByText("Order handling").closest(".unit")!;
    expect(orderUnit.querySelector(".unit__progress")!.textContent).toBe("1/2");
  });

  it("shows a test chip counting changed/total linked tests and selects a test on click", () => {
    const onSelect = vi.fn();
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={onSelect} />);
    const chip = screen.getByTestId("test-chip-u1"); // handleOrder unit: n-t1 changed, n-t2 not
    expect(chip.textContent).toContain("tests 1/2");
    expect(chip.className).not.toContain("unit__tests--warn");
    fireEvent.click(chip);
    expect(onSelect).toHaveBeenCalledWith("n-t1");
  });

  it("warns when linked tests exist but none changed, hides when none linked", () => {
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    const warnChip = screen.getByTestId("test-chip-u2"); // validateOrder unit: only unchanged n-t2
    expect(warnChip.textContent).toContain("tests 0/1");
    expect(warnChip.className).toContain("unit__tests--warn");
    expect(screen.queryByTestId("test-chip-u4")).not.toBeInTheDocument(); // merged unit: no test edges
  });

  it("renames a unit inline on double-click", () => {
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    fireEvent.doubleClick(screen.getByText("Order handling"));
    const input = screen.getByDisplayValue("Order handling");
    fireEvent.change(input, { target: { value: "Orders end-to-end" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockUpdateUnit).toHaveBeenCalledWith({ unitId: "u1", label: "Orders end-to-end" });
  });

  it("does not allow renaming the auto unit", () => {
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    fireEvent.doubleClick(screen.getByText("Unassigned changes"));
    expect(screen.queryByDisplayValue("Unassigned changes")).not.toBeInTheDocument();
  });

  it("collapses and expands a unit via the header chevron", () => {
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    const chevron = screen.getAllByTestId("unit-collapse")[0];
    fireEvent.click(chevron);
    expect(screen.queryByText("handleOrder")).not.toBeInTheDocument();
    fireEvent.click(chevron);
    expect(screen.getByText("handleOrder")).toBeInTheDocument();
  });

  it("marks remaining nodes reviewed after confirm, in one bulk call", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    // First unit ("Order handling"): one unreviewed changed step (handleOrder)
    fireEvent.click(screen.getAllByTestId("mark-remaining")[0]);
    expect(mockBulkMutate).toHaveBeenCalledTimes(1);
    expect(mockBulkMutate).toHaveBeenCalledWith({
      nodeIds: expect.arrayContaining(["n1"]),
      reviewStatus: "reviewed-clean",
    });
  });

  it("collapses consecutive off-path steps into an expandable run", () => {
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    expect(screen.getByText("⋯ 2 unchanged calls")).toBeInTheDocument();
    expect(screen.queryByText("ctxHelperOne")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("⋯ 2 unchanged calls"));
    expect(screen.getByText("ctxHelperOne")).toBeInTheDocument();
    expect(screen.getByText("ctxHelperTwo")).toBeInTheDocument();
  });

  it("shows entry confidence on flow units", () => {
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    const chip = screen.getByTestId("entry-conf-u1");
    expect(chip.textContent).toContain("70%");
    expect(chip).toHaveAttribute("title", expect.stringContaining("exported"));
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

  it("renders the overview block above the units when the session has one", () => {
    mockOverview = "Adds Redis rate limiting; units 1-2 are the config foundation.";
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    const block = screen.getByTestId("plan-overview");
    expect(block).toHaveTextContent("Adds Redis rate limiting");
    expect(block).toHaveTextContent("from plan");
  });

  it("renders no overview block when the session has none", () => {
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    expect(screen.queryByTestId("plan-overview")).toBeNull();
  });

  it("collapses the overview on toggle", () => {
    mockOverview = "Adds Redis rate limiting.";
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    fireEvent.click(screen.getByTestId("plan-overview-toggle"));
    expect(screen.queryByText("Adds Redis rate limiting.")).toBeNull();
  });
});
