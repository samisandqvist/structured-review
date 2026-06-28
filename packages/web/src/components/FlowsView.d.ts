/**
 * EXPERIMENT: review a change as the set of execution flows it touches.
 * Each flow is a left→right track of steps (entry point → leaf). Flows that
 * pass through a changed node are surfaced first; steps that map to a session
 * node are clickable and load that node's diff in the shared panel.
 */
export declare function FlowsView({ sessionId, currentNodeId, onSelectNode, }: {
    sessionId: string;
    currentNodeId: string | null;
    onSelectNode: (nodeId: string) => void;
}): import("react").JSX.Element;
//# sourceMappingURL=FlowsView.d.ts.map