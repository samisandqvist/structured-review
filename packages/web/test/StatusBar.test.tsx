import { render, screen, fireEvent } from "@testing-library/react";
import { vi } from "vitest";

const sessionList = [
  { id: "s1", branch: "feat", baseRef: "main", status: "walking", createdAt: 1 },
  { id: "s2", branch: "other-branch", baseRef: "main", status: "walking", createdAt: 2 },
];

vi.mock("../src/api/hooks.js", () => ({
  useSession: () => ({ data: { session: { branch: "feat" }, units: [{}, {}], coverage: { changedTotal: 5, covered: 4, unassigned: 1 }, stale: true } }),
  useNodes: () => ({ data: { nodes: [] } }),
  useSessions: () => ({ data: { sessions: sessionList } }),
}));

vi.mock("../src/navigation.js", () => ({
  navigateToSession: vi.fn(),
}));

import { StatusBar } from "../src/App.js";
import { navigateToSession } from "../src/navigation.js";

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

describe("StatusBar session switcher", () => {
  it("offers a branch dropdown when several sessions exist", () => {
    render(<StatusBar sessionId="s1" />);
    const select = screen.getByTestId("session-switcher") as HTMLSelectElement;
    expect(select.value).toBe("s1");
    expect(screen.getByRole("option", { name: "feat" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "other-branch" })).toBeInTheDocument();
  });

  it("navigates when another session is picked", () => {
    render(<StatusBar sessionId="s1" />);
    fireEvent.change(screen.getByTestId("session-switcher"), { target: { value: "s2" } });
    expect(navigateToSession).toHaveBeenCalledWith("s2");
  });
});
