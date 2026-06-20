import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/App.js";

vi.mock("../src/api/hooks.js", () => ({
  useNodes: () => ({ data: { nodes: [] }, isLoading: false }),
  useNode: () => ({ data: undefined, isLoading: false }),
  useUpdateNodeStatus: () => ({ mutate: vi.fn() }),
  useComments: () => ({ data: { comments: [] }, isLoading: false }),
  useCreateComment: () => ({ mutate: vi.fn() }),
}));

describe("App", () => {
  it("renders the header", () => {
    render(<App />);
    expect(screen.getByText("Code Review Walkthrough")).toBeInTheDocument();
  });
  it("renders graph and diff placeholders", () => {
    render(<App />);
    expect(screen.getAllByText("Select a node to begin").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("Diff view")).not.toBeInTheDocument();
  });
});
