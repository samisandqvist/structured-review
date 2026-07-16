import { describe, it, expect, beforeEach } from "vitest";
import { useUIStore } from "../src/store/ui.js";
import type { CommentAnchor } from "../src/api/client.js";

const anchor: CommentAnchor = { startLine: 3, startSide: "new", endLine: 5, endSide: "new" };
const selection = { startIdx: 1, endIdx: 3, anchor, label: "lines +3…+5" };

beforeEach(() => {
  useUIStore.setState({ lineSelection: null, pendingAnchorHighlight: null, currentNodeId: null });
});

describe("line selection state", () => {
  it("sets and clears a line selection", () => {
    useUIStore.getState().setLineSelection(selection);
    expect(useUIStore.getState().lineSelection).toEqual(selection);
    useUIStore.getState().setLineSelection(null);
    expect(useUIStore.getState().lineSelection).toBeNull();
  });

  it("changing the current node clears selection and pending highlight", () => {
    useUIStore.getState().setLineSelection(selection);
    useUIStore.getState().requestAnchorHighlight(anchor);
    useUIStore.getState().setCurrentNode("other-node");
    expect(useUIStore.getState().lineSelection).toBeNull();
    expect(useUIStore.getState().pendingAnchorHighlight).toBeNull();
  });

  it("anchor highlight request round-trip", () => {
    useUIStore.getState().requestAnchorHighlight(anchor);
    expect(useUIStore.getState().pendingAnchorHighlight).toEqual(anchor);
    useUIStore.getState().clearAnchorHighlight();
    expect(useUIStore.getState().pendingAnchorHighlight).toBeNull();
  });
});
