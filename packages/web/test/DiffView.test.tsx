import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  DiffView, anchorFor, selectionLabel, resolveAnchorRows, withSeparators, mergeExpanded,
} from "../src/components/DiffView.js";
import { useUIStore } from "../src/store/ui.js";
import { api, type DiffLine, type NodeDiff } from "../src/api/client.js";

const baseNode = {
  id: "n1", sessionId: "s1", stableId: "fn:handleOrder", unitId: "u1",
  label: "handleOrder", file: "src/orders.ts", startLine: 10, endLine: 30,
  changeStatus: "changed" as const, reviewStatus: "unreviewed" as const, reviewedInUnit: null, isTest: false,
};

const diff: NodeDiff = {
  oldText: "const a = 1;\nconst b = 2;",
  newText: "const a = 1;\nconst b = 3;",
  lines: [
    { type: "context", oldLine: 10, newLine: 10, text: "const a = 1;" },
    { type: "removed", oldLine: 11, newLine: null, text: "const b = 2;" },
    { type: "added", oldLine: null, newLine: 11, text: "const b = 3;" },
  ],
};

describe("DiffView", () => {
  it("renders the node label and file path", () => {
    render(<DiffView node={baseNode} />);
    expect(screen.getByText("handleOrder")).toBeInTheDocument();
  });
  it("shows unchanged badge for context nodes", () => {
    render(<DiffView node={{ ...baseNode, changeStatus: "unchanged" }} />);
    expect(screen.getByText(/unchanged/)).toBeInTheDocument();
  });
  it("shows an off-graph badge with tooltip for residual nodes", () => {
    render(<DiffView node={{ ...baseNode, residualKind: "module-scope" }} />);
    const badge = screen.getByTestId("residual-badge");
    expect(badge.textContent).toContain("off-graph");
    expect(badge).toHaveAttribute("title", expect.stringContaining("call graph"));
  });

  it("renders real file line numbers from hunk coordinates", () => {
    render(<DiffView node={baseNode} diff={diff} />);
    const addedRow = screen.getByText("const b = 3;").closest("tr")!;
    expect(addedRow).toHaveAttribute("data-line-type", "added");
    expect(addedRow.textContent).toContain("11");
    const removedRow = screen.getByText("const b = 2;").closest("tr")!;
    expect(removedRow).toHaveAttribute("data-line-type", "removed");
  });

  it("renders a gap separator between discontinuous regions", () => {
    const gappy: NodeDiff = {
      oldText: "a\nz", newText: "a\nz",
      lines: [
        { type: "context", oldLine: 1, newLine: 1, text: "a" },
        { type: "context", oldLine: 30, newLine: 30, text: "z" },
      ],
    };
    render(<DiffView node={baseNode} diff={gappy} />);
    // inner gap (lines 2–29) + bottom-edge expander
    expect(screen.getAllByTestId("diff-gap").length).toBe(2);
  });
});

describe("context expansion helpers", () => {
  it("withSeparators reports the hidden new-file range of each gap", () => {
    const rows = withSeparators([
      { type: "context", oldLine: 5, newLine: 5, text: "a" },
      { type: "context", oldLine: 30, newLine: 30, text: "z" },
    ]);
    const gap = rows.find((r) => "gap" in r) as { gap: { hiddenStart: number; hiddenEnd: number } };
    expect(gap.gap).toEqual({ hiddenStart: 6, hiddenEnd: 29 });
  });

  it("withSeparators uses the next known new line for a leading removed row", () => {
    const rows = withSeparators([
      { type: "context", oldLine: 5, newLine: 5, text: "a" },
      { type: "removed", oldLine: 28, newLine: null, text: "gone" },
      { type: "added", oldLine: null, newLine: 30, text: "fresh" },
    ]);
    const gap = rows.find((r) => "gap" in r) as { gap: { hiddenStart: number; hiddenEnd: number } };
    expect(gap.gap).toEqual({ hiddenStart: 6, hiddenEnd: 29 });
  });

  it("mergeExpanded splices a block between shown lines by new-file position", () => {
    const shown: DiffLine[] = [
      { type: "context", oldLine: 5, newLine: 5, text: "a" },
      { type: "context", oldLine: 30, newLine: 30, text: "z" },
    ];
    const block = {
      start: 6,
      lines: [{ type: "context" as const, oldLine: 6, newLine: 6, text: "b", expanded: true }],
    };
    const merged = mergeExpanded(shown, [block]);
    expect(merged.map((l) => l.newLine)).toEqual([5, 6, 30]);
  });

  it("mergeExpanded appends a bottom block and prepends a top block", () => {
    const shown: DiffLine[] = [{ type: "context", oldLine: 10, newLine: 10, text: "m" }];
    const merged = mergeExpanded(shown, [
      { start: 11, lines: [{ type: "context", oldLine: 11, newLine: 11, text: "after", expanded: true }] },
      { start: 1, lines: [{ type: "context", oldLine: 1, newLine: 1, text: "before", expanded: true }] },
    ]);
    expect(merged.map((l) => l.newLine)).toEqual([1, 10, 11]);
  });
});

describe("context expansion interaction", () => {
  afterEach(() => vi.restoreAllMocks());

  it("expands a small gap in one click and renders the fetched rows inert", async () => {
    const gappy: NodeDiff = {
      oldText: "", newText: "",
      lines: [
        { type: "context", oldLine: 1, newLine: 1, text: "a" },
        { type: "added", oldLine: null, newLine: 5, text: "z" },
      ],
    };
    const spy = vi.spyOn(api, "getNodeContext").mockResolvedValue({
      lines: [
        { type: "context", oldLine: 2, newLine: 2, text: "hidden-b" },
        { type: "context", oldLine: 3, newLine: 3, text: "hidden-c" },
        { type: "context", oldLine: 4, newLine: 4, text: "hidden-d" },
      ],
    });
    render(<DiffView node={baseNode} diff={gappy} />);
    fireEvent.click(screen.getAllByTestId("expand-all")[0]);
    await waitFor(() => expect(screen.getByText("hidden-b")).toBeInTheDocument());
    expect(spy).toHaveBeenCalledWith("s1", "n1", 2, 4);
    const row = screen.getByText("hidden-c").closest("tr")!;
    expect(row).toHaveAttribute("data-expanded", "true");
    fireEvent.click(row); // expanded context is not anchorable
    expect(useUIStore.getState().lineSelection).toBeNull();
  });

  it("offers directional expanders for a large gap", () => {
    const gappy: NodeDiff = {
      oldText: "", newText: "",
      lines: [
        { type: "context", oldLine: 1, newLine: 1, text: "a" },
        { type: "context", oldLine: 100, newLine: 100, text: "z" },
      ],
    };
    render(<DiffView node={baseNode} diff={gappy} />);
    expect(screen.getByTestId("expand-down")).toBeInTheDocument();
    expect(screen.getByTestId("expand-up")).toBeInTheDocument();
  });

  it("hides the bottom expander once EOF is reached", async () => {
    vi.spyOn(api, "getNodeContext").mockResolvedValue({ lines: [] });
    const tiny: NodeDiff = {
      oldText: "", newText: "",
      lines: [{ type: "context", oldLine: 1, newLine: 1, text: "only" }],
    };
    render(<DiffView node={baseNode} diff={tiny} />);
    fireEvent.click(screen.getByTestId("expand-all")); // bottom edge: [2, 21]
    await waitFor(() => expect(screen.queryByTestId("diff-gap")).not.toBeInTheDocument());
  });
});

const NODE = baseNode;

const LINES: DiffLine[] = [
  { type: "context", oldLine: 10, newLine: 10, text: "ctx" },
  { type: "removed", oldLine: 11, newLine: null, text: "gone" },
  { type: "added", oldLine: null, newLine: 11, text: "fresh" },
  { type: "added", oldLine: null, newLine: 12, text: "more" },
];

describe("anchor helpers", () => {
  it("derives a mixed-side anchor from row indexes", () => {
    expect(anchorFor(LINES, 1, 3)).toEqual({ startLine: 11, startSide: "old", endLine: 12, endSide: "new" });
  });
  it("refuses context endpoints", () => {
    expect(anchorFor(LINES, 0, 2)).toBeNull();
  });
  it("labels single and range selections", () => {
    expect(selectionLabel({ startLine: 12, startSide: "new", endLine: 12, endSide: "new" })).toBe("line +12");
    expect(selectionLabel({ startLine: 11, startSide: "old", endLine: 12, endSide: "new" })).toBe("lines -11…+12");
  });
  it("resolves an anchor back to row indexes", () => {
    expect(resolveAnchorRows(LINES, { startLine: 11, startSide: "old", endLine: 12, endSide: "new" })).toEqual({ startIdx: 1, endIdx: 3 });
    expect(resolveAnchorRows(LINES, { startLine: 99, startSide: "new", endLine: 99, endSide: "new" })).toBeNull();
  });
});

describe("line selection interaction", () => {
  beforeEach(() => useUIStore.setState({ lineSelection: null, pendingAnchorHighlight: null }));

  // Row 0 is the top-edge expander (LINES start at line 10); data rows follow.
  it("click on a changed line selects it; shift-click extends; context click is inert", () => {
    render(<DiffView node={NODE} diff={{ oldText: "", newText: "", lines: LINES }} />);
    const rows = screen.getAllByRole("row");
    fireEvent.click(rows[3]); // added newLine 11
    expect(useUIStore.getState().lineSelection?.anchor).toEqual({ startLine: 11, startSide: "new", endLine: 11, endSide: "new" });
    fireEvent.click(rows[4], { shiftKey: true }); // extend to newLine 12
    expect(useUIStore.getState().lineSelection?.anchor).toEqual({ startLine: 11, startSide: "new", endLine: 12, endSide: "new" });
    fireEvent.click(rows[1]); // context: inert
    expect(useUIStore.getState().lineSelection?.anchor).toEqual({ startLine: 11, startSide: "new", endLine: 12, endSide: "new" });
  });

  it("clicking the single selected line clears the selection", () => {
    render(<DiffView node={NODE} diff={{ oldText: "", newText: "", lines: LINES }} />);
    const rows = screen.getAllByRole("row");
    fireEvent.click(rows[3]);
    fireEvent.click(rows[3]);
    expect(useUIStore.getState().lineSelection).toBeNull();
  });

  it("selected rows carry a data-selected attribute", () => {
    render(<DiffView node={NODE} diff={{ oldText: "", newText: "", lines: LINES }} />);
    const rows = screen.getAllByRole("row");
    fireEvent.click(rows[2]);
    fireEvent.click(rows[4], { shiftKey: true });
    expect(rows[2]).toHaveAttribute("data-selected", "true");
    expect(rows[3]).toHaveAttribute("data-selected", "true");
    expect(rows[4]).toHaveAttribute("data-selected", "true");
    expect(rows[1]).not.toHaveAttribute("data-selected", "true");
  });

  it("resolves a pending anchor highlight into a selection and clears the request", () => {
    useUIStore.setState({ pendingAnchorHighlight: { startLine: 11, startSide: "new", endLine: 12, endSide: "new" } });
    render(<DiffView node={NODE} diff={{ oldText: "", newText: "", lines: LINES }} />);
    expect(useUIStore.getState().lineSelection?.startIdx).toBe(2);
    expect(useUIStore.getState().lineSelection?.endIdx).toBe(3);
    expect(useUIStore.getState().pendingAnchorHighlight).toBeNull();
  });
});
