import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FrontierStrip } from "../src/components/FrontierStrip.js";

const nodes = [
  { id: "n1", label: "handleOrder", reviewStatus: "unreviewed" as const, changeStatus: "changed" as const },
  { id: "n2", label: "validateOrder", reviewStatus: "reviewed-clean" as const, changeStatus: "changed" as const },
];

describe("FrontierStrip", () => {
  it("renders all nodes as agenda items", () => {
    render(<FrontierStrip nodes={nodes} currentNodeId="n1" onSelectNode={() => {}} />);
    expect(screen.getByText("handleOrder")).toBeInTheDocument();
    expect(screen.getByText("validateOrder")).toBeInTheDocument();
  });
  it("marks the current node", () => {
    render(<FrontierStrip nodes={nodes} currentNodeId="n1" onSelectNode={() => {}} />);
    expect(screen.getByText("handleOrder").parentElement!.style.fontWeight).toBe("bold");
  });
});
