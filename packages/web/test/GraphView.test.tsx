import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GraphView } from "../src/components/GraphView.js";

vi.mock("../src/api/hooks.js", () => ({
  useNode: () => ({
    data: {
      node: {
        id: "n1", sessionId: "s1", stableId: "fn:handleOrder", unitId: "u1",
        label: "handleOrder", file: "src/orders.ts", startLine: 10, endLine: 30,
        changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null,
      },
      callers: [],
      callees: [{
        id: "n2", sessionId: "s1", stableId: "fn:validateOrder", unitId: null,
        label: "validateOrder", file: "src/orders.ts", startLine: 35, endLine: 50,
        changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null,
      }],
    },
    isLoading: false,
  }),
}));

function renderWithProviders(ui: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

describe("GraphView", () => {
  it("renders the current node label", () => {
    renderWithProviders(<GraphView sessionId="s1" currentNodeId="n1" onSelectNode={() => {}} />);
    expect(screen.getAllByText("handleOrder").length).toBeGreaterThanOrEqual(1);
  });
  it("renders callee nodes", () => {
    renderWithProviders(<GraphView sessionId="s1" currentNodeId="n1" onSelectNode={() => {}} />);
    expect(screen.getByText("validateOrder")).toBeInTheDocument();
  });
});
