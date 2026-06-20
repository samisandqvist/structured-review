import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/App.js";

describe("App", () => {
  it("renders the header", () => {
    render(<App />);
    expect(screen.getByText("Code Review Walkthrough")).toBeInTheDocument();
  });
  it("renders graph and diff placeholders", () => {
    render(<App />);
    expect(screen.getByText("Graph view")).toBeInTheDocument();
    expect(screen.getByText("Diff view")).toBeInTheDocument();
  });
});
