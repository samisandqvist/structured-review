import { render, screen, fireEvent } from "@testing-library/react";
import { vi, beforeEach } from "vitest";
import { SplitLayout } from "../src/components/SplitLayout.js";
import { useUIStore } from "../src/store/ui.js";

const mockMutate = vi.fn();

const nodes = [
  { id: "n-a", stableId: "fn:a", label: "a", file: "f.ts", startLine: 1, endLine: 2, changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null, isTest: false },
  { id: "n-b", stableId: "fn:b", label: "b", file: "f.ts", startLine: 5, endLine: 6, changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null, isTest: false },
];

const callerNode = { id: "n-c", stableId: "fn:c", label: "c", file: "g.ts", startLine: 1, endLine: 3, changeStatus: "unchanged", reviewStatus: "unreviewed", reviewedInUnit: null, isTest: false };
const allNodes = [...nodes, callerNode];

vi.mock("../src/api/hooks.js", () => ({
  useSession: () => ({ data: { units: [
    { id: "u1", position: 0, kind: "orphans", label: "All", rationale: "", memberStableIds: ["fn:a", "fn:b"], auto: false },
  ], coverage: { changedTotal: 2, covered: 2, unassigned: 0 } } }),
  useFlows: () => ({ data: { flows: [], orphans: [] } }),
  useNodes: () => ({ data: { nodes, edges: [] } }),
  useNode: (_s: string, nodeId: string | null) => ({
    data: nodeId
      ? {
          node: allNodes.find((n) => n.id === nodeId),
          callers: nodeId === "n-a" ? [callerNode] : [],
          callees: [],
          diff: { oldText: "", newText: "", lines: [], totalLines: 0 },
        }
      : undefined,
  }),
  useUpdateNodeStatus: () => ({ mutate: mockMutate }),
  useBulkUpdateNodeStatus: () => ({ mutate: vi.fn() }),
  useUpdateUnit: () => ({ mutate: vi.fn() }),
  useComments: () => ({ data: { comments: [] } }),
  useCreateComment: () => ({ mutate: vi.fn() }),
}));

beforeEach(() => {
  mockMutate.mockClear();
  useUIStore.setState({ currentNodeId: null, walkPath: [] });
});

describe("Relations drawer detours", () => {
  it("clicking a relation opens it with a breadcrumb, return goes back to the walk", () => {
    useUIStore.setState({ currentNodeId: "n-a" });
    render(<SplitLayout sessionId="s1" currentNodeId="n-a" />);
    fireEvent.click(screen.getByTestId("relation-n-c"));
    expect(useUIStore.getState().currentNodeId).toBe("n-c");
    expect(useUIStore.getState().walkPath).toEqual(["n-a"]);
    expect(screen.getByTestId("breadcrumb")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("return-to-walk"));
    expect(useUIStore.getState().currentNodeId).toBe("n-a");
    expect(useUIStore.getState().walkPath).toEqual([]);
  });

  it("walk navigation clears a detour breadcrumb", () => {
    useUIStore.setState({ currentNodeId: "n-c", walkPath: ["n-a"] });
    render(<SplitLayout sessionId="s1" currentNodeId="n-c" />);
    fireEvent.keyDown(window, { key: "j" });
    expect(useUIStore.getState().walkPath).toEqual([]);
  });
});

describe("SplitLayout walk navigation", () => {
  it("advances to the next unreviewed node on 'n'", () => {
    render(<SplitLayout sessionId="s1" currentNodeId={null} />);
    fireEvent.keyDown(window, { key: "n" });
    expect(useUIStore.getState().currentNodeId).toBe("n-a");
    // n-a still unreviewed in mock data, so next unreviewed after it is n-b
    fireEvent.keyDown(window, { key: "n" });
    expect(useUIStore.getState().currentNodeId).toBe("n-b");
  });

  it("steps with j/k in walk order", () => {
    render(<SplitLayout sessionId="s1" currentNodeId={null} />);
    fireEvent.keyDown(window, { key: "j" });
    expect(useUIStore.getState().currentNodeId).toBe("n-a");
    fireEvent.keyDown(window, { key: "j" });
    expect(useUIStore.getState().currentNodeId).toBe("n-b");
    fireEvent.keyDown(window, { key: "k" });
    expect(useUIStore.getState().currentNodeId).toBe("n-a");
  });

  it("marks reviewed and advances on 'r'", () => {
    useUIStore.setState({ currentNodeId: "n-a" });
    render(<SplitLayout sessionId="s1" currentNodeId="n-a" />);
    fireEvent.keyDown(window, { key: "r" });
    expect(mockMutate).toHaveBeenCalledWith(
      { nodeId: "n-a", reviewStatus: "reviewed-clean" },
      expect.anything()
    );
  });

  it("ignores keys while typing in the comment box", () => {
    useUIStore.setState({ currentNodeId: "n-a" });
    render(<SplitLayout sessionId="s1" currentNodeId="n-a" />);
    const input = screen.getByTestId("comment-input");
    fireEvent.keyDown(input, { key: "r" });
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("has a Next unreviewed button in the diff footer", () => {
    useUIStore.setState({ currentNodeId: "n-a" });
    render(<SplitLayout sessionId="s1" currentNodeId="n-a" />);
    fireEvent.click(screen.getByTestId("next-unreviewed"));
    expect(useUIStore.getState().currentNodeId).toBe("n-b");
  });

  it("closes the shortcuts overlay on Escape even while an input has focus", () => {
    useUIStore.setState({ currentNodeId: "n-a" });
    const { container } = render(<SplitLayout sessionId="s1" currentNodeId="n-a" />);
    fireEvent.keyDown(window, { key: "?" });
    expect(container.querySelector(".keys-overlay")).toBeInTheDocument();
    const input = screen.getByTestId("comment-input");
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(container.querySelector(".keys-overlay")).not.toBeInTheDocument();
  });
});
