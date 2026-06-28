const API_BASE = "/api";
async function fetchJson(path, init) {
    const res = await fetch(`${API_BASE}${path}`, {
        ...init, headers: { "Content-Type": "application/json", ...init?.headers },
    });
    if (!res.ok)
        throw new Error(`API error: ${res.status}`);
    return res.json();
}
export const api = {
    createSession: (branch, baseRef) => fetchJson("/sessions", {
        method: "POST", body: JSON.stringify({ branch, baseRef }),
    }),
    getSession: (id) => fetchJson(`/sessions/${id}`),
    updatePlan: (id, units) => fetchJson(`/sessions/${id}/plan`, {
        method: "PUT", body: JSON.stringify({ units }),
    }),
    getNodes: (id) => fetchJson(`/sessions/${id}/nodes`),
    getNode: (sessionId, nodeId) => fetchJson(`/sessions/${sessionId}/nodes/${nodeId}`),
    updateNodeStatus: (sessionId, nodeId, reviewStatus, reviewedInUnit) => fetchJson(`/sessions/${sessionId}/nodes/${nodeId}`, {
        method: "PATCH", body: JSON.stringify({ reviewStatus, reviewedInUnit }),
    }),
    getComments: (id) => fetchJson(`/sessions/${id}/comments`),
    createComment: (id, nodeId, hunkSnippet, text, structuralContext) => fetchJson(`/sessions/${id}/comments`, {
        method: "POST", body: JSON.stringify({ nodeId, hunkSnippet, text, structuralContext }),
    }),
    getFlows: (id) => fetchJson(`/sessions/${id}/flows`),
    exportComments: (id) => fetchJson(`/sessions/${id}/export`),
};
//# sourceMappingURL=client.js.map