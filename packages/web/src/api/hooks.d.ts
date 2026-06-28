export declare function useSession(sessionId: string): import("@tanstack/react-query").UseQueryResult<NoInfer<{
    session: import("./client.js").ReviewSession;
    units: import("./client.js").Unit[];
    coverage: import("./client.js").Coverage;
}>, Error>;
export declare function useNodes(sessionId: string): import("@tanstack/react-query").UseQueryResult<NoInfer<{
    nodes: import("./client.js").Node[];
    edges: import("./client.js").GraphEdgeDTO[];
}>, Error>;
export declare function useNode(sessionId: string, nodeId: string | null): import("@tanstack/react-query").UseQueryResult<NoInfer<{
    node: import("./client.js").Node;
    callers: import("./client.js").Node[];
    callees: import("./client.js").Node[];
    diff: import("./client.js").NodeDiff;
}>, Error>;
export declare function useComments(sessionId: string): import("@tanstack/react-query").UseQueryResult<NoInfer<{
    comments: import("./client.js").Comment[];
}>, Error>;
export declare function useFlows(sessionId: string): import("@tanstack/react-query").UseQueryResult<NoInfer<{
    flows: import("./client.js").Flow[];
    orphans: import("./client.js").Node[];
}>, Error>;
export declare function useUpdateNodeStatus(sessionId: string): import("@tanstack/react-query").UseMutationResult<{
    node: import("./client.js").Node;
}, Error, {
    nodeId: string;
    reviewStatus: "unreviewed" | "reviewed-clean" | "reviewed-commented" | "reviewed-elsewhere";
    reviewedInUnit?: number;
}, unknown>;
export declare function useCreateComment(sessionId: string): import("@tanstack/react-query").UseMutationResult<{
    comment: import("./client.js").Comment;
}, Error, {
    nodeId: string;
    hunkSnippet: string;
    text: string;
    structuralContext: string;
}, unknown>;
//# sourceMappingURL=hooks.d.ts.map