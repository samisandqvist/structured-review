import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client.js";
export function useSession(sessionId) {
    return useQuery({ queryKey: ["session", sessionId], queryFn: () => api.getSession(sessionId) });
}
export function useNodes(sessionId) {
    return useQuery({ queryKey: ["nodes", sessionId], queryFn: () => api.getNodes(sessionId) });
}
export function useNode(sessionId, nodeId) {
    return useQuery({
        queryKey: ["node", sessionId, nodeId], queryFn: () => api.getNode(sessionId, nodeId),
        enabled: !!nodeId,
    });
}
export function useComments(sessionId) {
    return useQuery({ queryKey: ["comments", sessionId], queryFn: () => api.getComments(sessionId) });
}
export function useFlows(sessionId) {
    return useQuery({ queryKey: ["flows", sessionId], queryFn: () => api.getFlows(sessionId) });
}
export function useUpdateNodeStatus(sessionId) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: ({ nodeId, reviewStatus, reviewedInUnit }) => api.updateNodeStatus(sessionId, nodeId, reviewStatus, reviewedInUnit),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["nodes", sessionId] });
            qc.invalidateQueries({ queryKey: ["node", sessionId] });
        },
    });
}
export function useCreateComment(sessionId) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: ({ nodeId, hunkSnippet, text, structuralContext }) => api.createComment(sessionId, nodeId, hunkSnippet, text, structuralContext),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["comments", sessionId] });
            qc.invalidateQueries({ queryKey: ["nodes", sessionId] });
        },
    });
}
//# sourceMappingURL=hooks.js.map