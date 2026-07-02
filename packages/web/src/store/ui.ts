import { create } from "zustand";
import { persist } from "zustand/middleware";

// UI state persists per session so a review survives a reload / another sitting.
const sessionKey = new URLSearchParams(window.location.search).get("session") ?? "default";

interface UIState {
  splitRatio: number;
  currentUnitIndex: number;
  currentNodeId: string | null;
  walkPath: string[];
  overviewOpen: boolean;
  collapsedUnits: string[];
  /** Manually re-expanded units that would otherwise auto-collapse (fully reviewed). */
  expandedUnits: string[];
  setSplitRatio: (ratio: number) => void;
  setCurrentUnit: (index: number) => void;
  setCurrentNode: (nodeId: string | null) => void;
  pushToWalkPath: (nodeId: string) => void;
  popWalkPath: () => void;
  toggleOverview: () => void;
  toggleUnitCollapsed: (unitId: string, currentlyCollapsed: boolean) => void;
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
      setSplitRatio: (ratio) => set({ splitRatio: Math.max(0.1, Math.min(0.9, ratio)) }),
      setCurrentUnit: (index) => set({ currentUnitIndex: index, currentNodeId: null, walkPath: [] }),
      setCurrentNode: (nodeId) => set({ currentNodeId: nodeId }),
      pushToWalkPath: (nodeId) => set((s) => ({ walkPath: [...s.walkPath, nodeId] })),
      popWalkPath: () => set((s) => ({ walkPath: s.walkPath.slice(0, -1) })),
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
