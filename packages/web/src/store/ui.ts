import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CommentAnchor } from "../api/client.js";

// UI state persists per session so a review survives a reload / another sitting.
const sessionKey = new URLSearchParams(window.location.search).get("session") ?? "default";

export interface LineSelection {
  startIdx: number;
  endIdx: number;
  /** The row the selection started from — shift-click and drag move the OTHER
   *  end relative to this, so ranges can shrink and flip. Defaults to startIdx. */
  anchorIdx?: number;
  anchor: CommentAnchor;
  label: string;
}

export type SelectionSource = "click" | "walk";

interface UIState {
  splitRatio: number;
  currentUnitIndex: number;
  currentNodeId: string | null;
  /** How the current node was selected. A click selects the chip under the pointer, which is
   *  already in view, so the plan must not scroll; a walk (j/k/n/r, relation jump) moves the
   *  plan to the node's home chip. Not persisted. */
  selectionSource: SelectionSource;
  walkPath: string[];
  overviewOpen: boolean;
  collapsedUnits: string[];
  /** Manually re-expanded units that would otherwise auto-collapse (fully reviewed). */
  expandedUnits: string[];
  /** Ephemeral: the diff-line range currently selected for commenting. Not persisted. */
  lineSelection: LineSelection | null;
  /** Ephemeral: an anchor a consumer (e.g. jumping from an export) asked the diff view to scroll to and highlight. Not persisted. */
  pendingAnchorHighlight: CommentAnchor | null;
  setSplitRatio: (ratio: number) => void;
  setCurrentUnit: (index: number) => void;
  setCurrentNode: (nodeId: string | null, source?: SelectionSource) => void;
  pushToWalkPath: (nodeId: string) => void;
  truncateWalkPath: (index: number) => void;
  toggleOverview: () => void;
  toggleUnitCollapsed: (unitId: string, currentlyCollapsed: boolean) => void;
  setLineSelection: (sel: LineSelection | null) => void;
  requestAnchorHighlight: (anchor: CommentAnchor) => void;
  clearAnchorHighlight: () => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      splitRatio: 1 / 3, // left (plan) : right (diff) ≈ 1:2

      currentUnitIndex: 0,
      currentNodeId: null,
      selectionSource: "walk",
      walkPath: [],
      overviewOpen: false,
      collapsedUnits: [],
      expandedUnits: [],
      lineSelection: null as LineSelection | null,
      pendingAnchorHighlight: null as CommentAnchor | null,
      setSplitRatio: (ratio) => set({ splitRatio: Math.max(0.1, Math.min(0.9, ratio)) }),
      setCurrentUnit: (index) => set({ currentUnitIndex: index, currentNodeId: null, walkPath: [] }),
      setCurrentNode: (nodeId, source = "walk") =>
        set({ currentNodeId: nodeId, selectionSource: source, lineSelection: null, pendingAnchorHighlight: null }),
      pushToWalkPath: (nodeId) => set((s) => ({ walkPath: [...s.walkPath, nodeId] })),
      truncateWalkPath: (index) => set((s) => ({ walkPath: s.walkPath.slice(0, index) })),
      toggleOverview: () => set((s) => ({ overviewOpen: !s.overviewOpen })),
      toggleUnitCollapsed: (unitId, currentlyCollapsed) =>
        set((s) =>
          currentlyCollapsed
            ? {
                collapsedUnits: s.collapsedUnits.filter((id) => id !== unitId),
                expandedUnits: [...new Set([...s.expandedUnits, unitId])],
              }
            : {
                collapsedUnits: [...new Set([...s.collapsedUnits, unitId])],
                expandedUnits: s.expandedUnits.filter((id) => id !== unitId),
              },
        ),
      setLineSelection: (sel) => set({ lineSelection: sel }),
      requestAnchorHighlight: (anchor) => set({ pendingAnchorHighlight: anchor }),
      clearAnchorHighlight: () => set({ pendingAnchorHighlight: null }),
    }),
    {
      name: `srev-ui:${sessionKey}`,
      partialize: (s) => ({
        currentNodeId: s.currentNodeId,
        splitRatio: s.splitRatio,
        collapsedUnits: s.collapsedUnits,
        expandedUnits: s.expandedUnits,
      }),
    },
  ),
);
