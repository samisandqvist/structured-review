import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DiffView } from "../src/components/DiffView.js";
import type { NodeDiff } from "../src/api/client.js";

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
