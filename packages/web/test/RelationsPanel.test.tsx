import { render, screen, fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import { RelationsPanel } from "../src/components/RelationsPanel.js";
import type { Node } from "../src/api/client.js";

const mk = (over: Partial<Node>): Node => ({
  id: "n-x", sessionId: "s1", stableId: "fn:x", label: "x", file: "src/x.ts",
  startLine: 1, endLine: 9, changeStatus: "unchanged", reviewStatus: "unreviewed",
  reviewedInUnit: null, isTest: false, ...over,
});

describe("RelationsPanel", () => {
  it("shows callers and callees with state chips", () => {
    render(
      <RelationsPanel
        callers={[mk({ id: "n-c", label: "caller", changeStatus: "changed" }), mk({ id: "n-t", label: "spec", isTest: true })]}
        callees={[mk({ id: "n-e", label: "callee" })]}
        walkStableIds={new Set(["fn:x"])}
        onSelect={() => {}}
      />
    );
    expect(screen.getByText("caller")).toBeInTheDocument();
    expect(screen.getByText("callee")).toBeInTheDocument();
    expect(screen.getByText("changed")).toBeInTheDocument();
    expect(screen.getByText("test")).toBeInTheDocument();
    expect(screen.getAllByText("in walk").length).toBeGreaterThan(0);
  });

  it("invokes onSelect with the neighbor's node id", () => {
    const onSelect = vi.fn();
    render(
      <RelationsPanel callers={[mk({ id: "n-c", label: "caller" })]} callees={[]} walkStableIds={new Set()} onSelect={onSelect} />
    );
    fireEvent.click(screen.getByTestId("relation-n-c"));
    expect(onSelect).toHaveBeenCalledWith("n-c");
  });

  it("collapses and expands", () => {
    render(
      <RelationsPanel callers={[mk({ id: "n-c", label: "caller" })]} callees={[]} walkStableIds={new Set()} onSelect={() => {}} />
    );
    fireEvent.click(screen.getByTestId("relations-toggle"));
    expect(screen.queryByText("caller")).not.toBeInTheDocument();
  });

  it("renders nothing without neighbors", () => {
    const { container } = render(
      <RelationsPanel callers={[]} callees={[]} walkStableIds={new Set()} onSelect={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
