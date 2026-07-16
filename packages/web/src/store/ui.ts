import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CommentAnchor } from "../api/client.js";

// UI state persists per session so a review survives a reload / another sitting.
const sessionKey = new URLSearchParams(window.location.search).get("session") ?? "default";

export interface LineSelection {
  startIdx: number;
  endIdx: number;
  anchor: CommentAnchor;
  label: string;
}

interface UIState {
  splitRatio: number;
  currentUnitIndex: number;
  currentNodeId: string | null;
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
  setCurrentNode: (nodeId: string | null) => void;
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
      walkPath: [],
      overviewOpen: false,
      collapsedUnits: [],
      expandedUnits: [],
      lineSelection: null as LineSelection | null,
      pendingAnchorHighlight: null as CommentAnchor | null,
      setSplitRatio: (ratio) => set({ splitRatio: Math.max(0.1, Math.min(0.9, ratio)) }),
      setCurrentUnit: (index) => set({ currentUnitIndex: index, currentNodeId: null, walkPath: [] }),
      setCurrentNode: (nodeId) => set({ currentNodeId: nodeId, lineSelection: null, pendingAnchorHighlight: null }),
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
              }
        ),
      setLineSelection: (sel) => set({ lineSelection: sel }),
      requestAnchorHighlight: (anchor) => set({ pendingAnchorHighlight: anchor }),
      clearAnchorHighlight: () => set({ pendingAnchorHighlight: null }),
    }),
    {
      name: `crw-ui:${sessionKey}`,
      partialize: (s) => ({
        currentNodeId: s.currentNodeId,
        splitRatio: s.splitRatio,
        collapsedUnits: s.collapsedUnits,
        expandedUnits: s.expandedUnits,
      }),
    }
  )
);
