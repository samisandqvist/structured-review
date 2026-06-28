export interface ReviewSession {
    id: string;
    branch: string;
    baseRef: string;
    status: "planning" | "walking" | "complete";
    createdAt: number;
}
export interface Unit {
    id: string;
    sessionId: string;
    position: number;
    label: string;
    rationale: string;
    kind: "flow" | "orphans";
    memberStableIds: string[];
    auto: boolean;
}
export interface Node {
    id: string;
    sessionId: string;
    stableId: string;
    label: string;
    file: string;
    startLine: number;
    endLine: number;
    changeStatus: "changed" | "unchanged";
    reviewStatus: "unreviewed" | "reviewed-clean" | "reviewed-commented" | "reviewed-elsewhere";
    reviewedInUnit: number | null;
    isTest: boolean;
}
export interface Comment {
    id: string;
    sessionId: string;
    nodeId: string;
    hunkSnippet: string;
    text: string;
    structuralContext: string;
    createdAt: number;
}
export interface NodeDiff {
    oldText: string;
    newText: string;
}
export interface FlowStep {
    label: string;
    file: string;
    startLine: number;
    endLine: number;
    isTest: boolean;
    depth: number;
    nodeId: string | null;
    changeStatus: "changed" | "unchanged" | null;
    reviewStatus: Node["reviewStatus"] | null;
}
export interface Flow {
    id: number;
    name: string;
    criticality: number;
    depth: number;
    affected: boolean;
    steps: FlowStep[];
    entryStableId: string;
}
export interface GraphEdgeDTO {
    sourceNodeId: string;
    targetNodeId: string;
    edgeType: "call" | "test";
}
export interface GraphNode {
    stableId: string;
    label: string;
    file: string;
    startLine: number;
    endLine: number;
    isEntryPoint: boolean;
    changeStatus: "changed" | "unchanged";
}
export interface GraphEdge {
    sourceStableId: string;
    targetStableId: string;
    edgeType: "call";
}
export interface ChangeSubgraph {
    nodes: GraphNode[];
    edges: GraphEdge[];
}
export interface Coverage {
    changedTotal: number;
    covered: number;
    unassigned: number;
}
export type UnitInput = {
    kind: "flow";
    flowEntryStableId: string;
    label: string;
    rationale?: string;
} | {
    kind: "orphans";
    orphanStableIds: string[];
    label: string;
    rationale?: string;
};
export declare const api: {
    createSession: (branch: string, baseRef: string) => Promise<{
        session: ReviewSession;
        subgraph: ChangeSubgraph;
    }>;
    getSession: (id: string) => Promise<{
        session: ReviewSession;
        units: Unit[];
        coverage: Coverage;
    }>;
    updatePlan: (id: string, units: UnitInput[]) => Promise<{
        units: Unit[];
        coverage: Coverage;
    }>;
    getNodes: (id: string) => Promise<{
        nodes: Node[];
        edges: GraphEdgeDTO[];
    }>;
    getNode: (sessionId: string, nodeId: string) => Promise<{
        node: Node;
        callers: Node[];
        callees: Node[];
        diff: NodeDiff;
    }>;
    updateNodeStatus: (sessionId: string, nodeId: string, reviewStatus: Node["reviewStatus"], reviewedInUnit?: number) => Promise<{
        node: Node;
    }>;
    getComments: (id: string) => Promise<{
        comments: Comment[];
    }>;
    createComment: (id: string, nodeId: string, hunkSnippet: string, text: string, structuralContext: string) => Promise<{
        comment: Comment;
    }>;
    getFlows: (id: string) => Promise<{
        flows: Flow[];
        orphans: Node[];
    }>;
    exportComments: (id: string) => Promise<Record<string, unknown>>;
};
//# sourceMappingURL=client.d.ts.map