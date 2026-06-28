interface UIState {
    splitRatio: number;
    currentUnitIndex: number;
    currentNodeId: string | null;
    walkPath: string[];
    overviewOpen: boolean;
    setSplitRatio: (ratio: number) => void;
    setCurrentUnit: (index: number) => void;
    setCurrentNode: (nodeId: string | null) => void;
    pushToWalkPath: (nodeId: string) => void;
    popWalkPath: () => void;
    toggleOverview: () => void;
}
export declare const useUIStore: import("zustand").UseBoundStore<import("zustand").StoreApi<UIState>>;
export {};
//# sourceMappingURL=ui.d.ts.map