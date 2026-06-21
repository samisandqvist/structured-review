import { create } from "zustand";

type ViewMode = "graph" | "flows";

interface UIState {
  splitRatio: number;
  currentUnitIndex: number;
  currentNodeId: string | null;
  walkPath: string[];
  overviewOpen: boolean;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  setSplitRatio: (ratio: number) => void;
  setCurrentUnit: (index: number) => void;
  setCurrentNode: (nodeId: string | null) => void;
  pushToWalkPath: (nodeId: string) => void;
  popWalkPath: () => void;
  toggleOverview: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  splitRatio: 1 / 3, // left (flows/graph) : right (diff) ≈ 1:2

  currentUnitIndex: 0,
  currentNodeId: null,
  walkPath: [],
  overviewOpen: false,
  viewMode: "flows",
  setViewMode: (mode) => set({ viewMode: mode }),
  setSplitRatio: (ratio) => set({ splitRatio: Math.max(0.1, Math.min(0.9, ratio)) }),
  setCurrentUnit: (index) => set({ currentUnitIndex: index, currentNodeId: null, walkPath: [] }),
  setCurrentNode: (nodeId) => set({ currentNodeId: nodeId }),
  pushToWalkPath: (nodeId) => set((s) => ({ walkPath: [...s.walkPath, nodeId] })),
  popWalkPath: () => set((s) => ({ walkPath: s.walkPath.slice(0, -1) })),
  toggleOverview: () => set((s) => ({ overviewOpen: !s.overviewOpen })),
}));
