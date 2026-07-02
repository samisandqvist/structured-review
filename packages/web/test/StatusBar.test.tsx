import { render, screen } from "@testing-library/react";
import { vi } from "vitest";

vi.mock("../src/api/hooks.js", () => ({
  useSession: () => ({ data: { session: { branch: "feat" }, units: [{}, {}], coverage: { changedTotal: 5, covered: 4, unassigned: 1 }, stale: true } }),
  useNodes: () => ({ data: { nodes: [] } }),
}));

import { StatusBar } from "../src/App.js";

describe("StatusBar coverage chip", () => {
  it("shows units and a warning when changes are unassigned", () => {
    render(<StatusBar sessionId="s1" />);
    expect(screen.getByText(/2 units/)).toBeInTheDocument();
    expect(screen.getByText(/4\/5 changes/)).toBeInTheDocument();
    expect(screen.getByTestId("coverage-chip")).toHaveAttribute("data-warn", "true");
  });
});

describe("StatusBar stale chip", () => {
  it("shows a stale warning chip when the repo moved past the session", () => {
    render(<StatusBar sessionId="s1" />);
    expect(screen.getByTestId("stale-chip")).toHaveTextContent("repo moved since session start");
  });
});
