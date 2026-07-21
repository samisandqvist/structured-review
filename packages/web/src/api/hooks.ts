import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Node, type CommentAnchor } from "./client.js";

export function useSession(sessionId: string) {
  return useQuery({ queryKey: ["session", sessionId], queryFn: () => api.getSession(sessionId) });
}
export function useNodes(sessionId: string) {
  return useQuery({ queryKey: ["nodes", sessionId], queryFn: () => api.getNodes(sessionId) });
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
export function useBulkUpdateNodeStatus(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeIds, reviewStatus }: { nodeIds: string[]; reviewStatus: Node["reviewStatus"] }) =>
      api.bulkUpdateNodeStatus(sessionId, nodeIds, reviewStatus),
    onSuccess: () => {
      // One request, one invalidation wave — including flows, whose steps
      // carry per-node reviewStatus.
      qc.invalidateQueries({ queryKey: ["nodes", sessionId] });
      qc.invalidateQueries({ queryKey: ["node", sessionId] });
      qc.invalidateQueries({ queryKey: ["flows", sessionId] });
    },
  });
}
export function useUpdateUnit(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ unitId, ...patch }: { unitId: string; label?: string; position?: number }) =>
      api.updateUnit(sessionId, unitId, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["session", sessionId] });
    },
  });
}
export function useCreateComment(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, text, anchor }: { nodeId: string | null; text: string; anchor?: CommentAnchor }) =>
      api.createComment(sessionId, nodeId, text, anchor),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["comments", sessionId] });
      qc.invalidateQueries({ queryKey: ["nodes", sessionId] });
    },
  });
}
