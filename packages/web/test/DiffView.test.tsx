import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DiffView, anchorFor, selectionLabel, resolveAnchorRows } from "../src/components/DiffView.js";
import { useUIStore } from "../src/store/ui.js";
import type { DiffLine, NodeDiff } from "../src/api/client.js";

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
    expect(screen.getByTestId("diff-gap")).toBeInTheDocument();
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

  it("click on a changed line selects it; shift-click extends; context click is inert", () => {
    render(<DiffView node={NODE} diff={{ oldText: "", newText: "", lines: LINES }} />);
    const rows = screen.getAllByRole("row");
    fireEvent.click(rows[2]); // added newLine 11
    expect(useUIStore.getState().lineSelection?.anchor).toEqual({ startLine: 11, startSide: "new", endLine: 11, endSide: "new" });
    fireEvent.click(rows[3], { shiftKey: true }); // extend to newLine 12
    expect(useUIStore.getState().lineSelection?.anchor).toEqual({ startLine: 11, startSide: "new", endLine: 12, endSide: "new" });
    fireEvent.click(rows[0]); // context: inert
    expect(useUIStore.getState().lineSelection?.anchor).toEqual({ startLine: 11, startSide: "new", endLine: 12, endSide: "new" });
  });

  it("clicking the single selected line clears the selection", () => {
    render(<DiffView node={NODE} diff={{ oldText: "", newText: "", lines: LINES }} />);
    const rows = screen.getAllByRole("row");
    fireEvent.click(rows[2]);
    fireEvent.click(rows[2]);
    expect(useUIStore.getState().lineSelection).toBeNull();
  });

  it("selected rows carry a data-selected attribute", () => {
    render(<DiffView node={NODE} diff={{ oldText: "", newText: "", lines: LINES }} />);
    const rows = screen.getAllByRole("row");
    fireEvent.click(rows[1]);
    fireEvent.click(rows[3], { shiftKey: true });
    expect(rows[1]).toHaveAttribute("data-selected", "true");
    expect(rows[2]).toHaveAttribute("data-selected", "true");
    expect(rows[3]).toHaveAttribute("data-selected", "true");
    expect(rows[0]).not.toHaveAttribute("data-selected", "true");
  });

  it("resolves a pending anchor highlight into a selection and clears the request", () => {
    useUIStore.setState({ pendingAnchorHighlight: { startLine: 11, startSide: "new", endLine: 12, endSide: "new" } });
    render(<DiffView node={NODE} diff={{ oldText: "", newText: "", lines: LINES }} />);
    expect(useUIStore.getState().lineSelection?.startIdx).toBe(2);
    expect(useUIStore.getState().lineSelection?.endIdx).toBe(3);
    expect(useUIStore.getState().pendingAnchorHighlight).toBeNull();
  });
});
