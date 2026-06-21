import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client.js";

export function useSession(sessionId: string) {
  return useQuery({ queryKey: ["session", sessionId], queryFn: () => api.getSession(sessionId) });
}
export function useNodes(sessionId: string, unitId?: string) {
  return useQuery({ queryKey: ["nodes", sessionId, unitId], queryFn: () => api.getNodes(sessionId, unitId) });
}
export function useNode(sessionId: string, nodeId: string | null) {
  return useQuery({
    queryKey: ["node", sessionId, nodeId], queryFn: () => api.getNode(sessionId, nodeId!),
    enabled: !!nodeId,
  });
}
export function useComments(sessionId: string) {
  return useQuery({ queryKey: ["comments", sessionId], queryFn: () => api.getComments(sessionId) });
}
export function useFlows(sessionId: string) {
  return useQuery({ queryKey: ["flows", sessionId], queryFn: () => api.getFlows(sessionId) });
}
export function useUpdateNodeStatus(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, reviewStatus, reviewedInUnit }: {
      nodeId: string;
      reviewStatus: "unreviewed" | "reviewed-clean" | "reviewed-commented" | "reviewed-elsewhere";
      reviewedInUnit?: number;
    }) => api.updateNodeStatus(sessionId, nodeId, reviewStatus, reviewedInUnit),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["nodes", sessionId] });
      qc.invalidateQueries({ queryKey: ["node", sessionId] });
    },
  });
}
export function useCreateComment(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, hunkSnippet, text, structuralContext }: {
      nodeId: string; hunkSnippet: string; text: string; structuralContext: string;
    }) => api.createComment(sessionId, nodeId, hunkSnippet, text, structuralContext),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["comments", sessionId] });
      qc.invalidateQueries({ queryKey: ["nodes", sessionId] });
    },
  });
}
