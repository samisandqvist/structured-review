import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({
  sessions: undefined as undefined | Array<Record<string, unknown>>,
}));

vi.mock("../src/api/hooks.js", () => ({
  useSession: () => ({ data: { session: undefined, units: [] }, isLoading: false }),
  useSessions: () => ({
    data: state.sessions ? { sessions: state.sessions } : undefined,
    isLoading: state.sessions === undefined,
  }),
  useNodes: () => ({ data: { nodes: [] }, isLoading: false }),
  useNode: () => ({ data: undefined, isLoading: false }),
  useUpdateNodeStatus: () => ({ mutate: vi.fn() }),
  useComments: () => ({ data: { comments: [] }, isLoading: false }),
  useCreateComment: () => ({ mutate: vi.fn() }),
  useFlows: () => ({ data: { flows: [] }, isLoading: false }),
}));

import { App } from "../src/App.js";

function session(id: string, branch: string) {
  return { id, branch, baseRef: "main", status: "walking", createdAt: 1755000000000 };
}

beforeEach(() => {
  state.sessions = undefined;
  window.history.replaceState(null, "", "/");
});

describe("App with ?session in the URL", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/?session=ses_x");
  });
  it("renders the header", () => {
    render(<App />);
    expect(screen.getByText("Trace")).toBeInTheDocument();
  });
  it("renders graph and diff placeholders", () => {
    render(<App />);
    expect(screen.getAllByText("Pick a node to start the walk").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("Diff view")).not.toBeInTheDocument();
  });
});

describe("App without ?session", () => {
  it("shows the picker when several sessions exist", () => {
    state.sessions = [session("ses_a", "delegation-grants"), session("ses_b", "example-service-fusion")];
    render(<App />);
    expect(screen.getByTestId("session-picker")).toBeInTheDocument();
    expect(screen.getByText("delegation-grants")).toBeInTheDocument();
    expect(screen.queryByText("Pick a node to start the walk")).not.toBeInTheDocument();
  });

  it("loads a lone session directly and makes the URL shareable", () => {
    state.sessions = [session("ses_only", "solo-branch")];
    render(<App />);
    expect(screen.getAllByText("Pick a node to start the walk").length).toBeGreaterThanOrEqual(1);
    expect(window.location.search).toBe("?session=ses_only");
  });

  it("shows an empty state when no sessions exist", () => {
    state.sessions = [];
    render(<App />);
    expect(screen.getByTestId("session-empty")).toHaveTextContent(/no review sessions/i);
  });
});
