import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Node, type Flow, type Unit } from "../src/api/client.js";
import { useUpdateNodeStatus } from "../src/api/hooks.js";
import { PlanView } from "../src/components/PlanView.js";
import { StatusBar } from "../src/App.js";
import { useUIStore } from "../src/store/ui.js";

let client: QueryClient;
let node: Node;
let stale: boolean;

function Review() {
  const update = useUpdateNodeStatus("s");
  return <>
    <StatusBar sessionId="s" />
    <PlanView sessionId="s" currentNodeId="n" onSelectNode={() => {}} />
    <button onClick={() => update.mutate({ nodeId: "n", reviewStatus: "reviewed-clean" })}>Review this change</button>
  </>;
}

beforeEach(() => {
  stale = false;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  useUIStore.setState({ collapsedUnits: [], expandedUnits: [] });
  node = { id: "n", sessionId: "s", stableId: "fn:order", label: "order", file: "order.ts", startLine: 1, endLine: 3,
    changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null, isTest: false };
  const unit: Unit = { id: "u", sessionId: "s", position: 0, label: "Ordering", rationale: "", kind: "flow",
    memberStableIds: [node.stableId], auto: false, attached: [] };
  const session = { id: "s", branch: "main", baseRef: "HEAD", status: "walking" as const, createdAt: 1 };
  vi.spyOn(api, "listSessions").mockResolvedValue({ sessions: [session] });
  vi.spyOn(api, "getSession").mockImplementation(async () => ({ session, units: [unit], coverage: { covered: 1, changedTotal: 1, unassigned: 0 }, stale }));
  vi.spyOn(api, "getNodes").mockImplementation(async () => ({ nodes: [{ ...node }], edges: [] }));
  vi.spyOn(api, "getComments").mockResolvedValue({ comments: [] });
  vi.spyOn(api, "getFlows").mockImplementation(async () => ({ flows: [{
    id: 1, name: "order", criticality: 0, depth: 0, affected: true, changedStableIds: [node.stableId],
    entryStableId: node.stableId, entryReasons: ["exported"], entryConfidence: 0.7,
    steps: [{ ...node, nodeId: node.id, depth: 0 }],
  } satisfies Flow], orphans: [] }));
  vi.spyOn(api, "updateNodeStatus").mockImplementation(async (_s, _n, reviewStatus) => {
    node = { ...node, reviewStatus };
    return { node };
  });
});

afterEach(() => { client.clear(); vi.restoreAllMocks(); });

describe("live review feedback", () => {
  it("updates the flow unit's progress and auto-collapse after reviewing one node", async () => {
    const { container } = render(<QueryClientProvider client={client}><Review /></QueryClientProvider>);
    await waitFor(() => expect(container.querySelector(".unit__progress")).toHaveTextContent("0/1"));
    fireEvent.click(screen.getByRole("button", { name: "Review this change" }));
    await waitFor(() => expect(container.querySelector(".unit__progress")).toHaveTextContent("1/1"));
    expect(screen.getByTestId("unit-collapse")).toHaveAttribute("aria-label", "expand unit");
    expect(container.querySelector(".statusbar__progress")).toHaveTextContent("1/1");
  });

  it("shows the stale chip when the session snapshot no longer matches the tree", async () => {
    stale = true;
    render(<QueryClientProvider client={client}><StatusBar sessionId="s" /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId("stale-chip")).toHaveTextContent("recreate review"));
  });
});
