import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DB } from "../src/db/connection.js";
import { createMemoryDatabase } from "../src/db/connection.js";
import { createApp } from "../src/app.js";
import { StubGraphProvider } from "../src/graph/stub.js";

let db: DB;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  db = createMemoryDatabase();
  app = createApp({ db, graphProvider: new StubGraphProvider() });
});
afterEach(() => { db.close(); });

describe("POST /api/sessions", () => {
  it("creates a session and returns it with the change subgraph", async () => {
    const res = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session.id).toBeDefined();
    expect(body.session.branch).toBe("feat");
    expect(body.subgraph.nodes.length).toBeGreaterThan(0);
  });
});

describe("GET /api/sessions/:id", () => {
  it("returns session with units", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const res = await app.request(`/api/sessions/${session.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session.id).toBe(session.id);
    expect(body.units).toEqual([]);
  });
  it("returns 404 for unknown session", async () => {
    const res = await app.request("/api/sessions/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/sessions/:id/plan", () => {
  it("replaces the plan with new units", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const res = await app.request(`/api/sessions/${session.id}/plan`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        units: [{ label: "Order handlers", rationale: "all order endpoints", entryPointNodeIds: ["fn:handleOrder"] }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.units).toHaveLength(1);
    expect(body.units[0].label).toBe("Order handlers");
    expect(body.units[0].position).toBe(0);
  });
});

describe("GET /api/sessions/:id/nodes", () => {
  it("lists all nodes in a session", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const res = await app.request(`/api/sessions/${session.id}/nodes`);
    expect(res.status).toBe(200);
    expect((await res.json()).nodes.length).toBeGreaterThan(0);
  });
});

describe("PATCH /api/sessions/:id/nodes/:nodeId", () => {
  it("updates node review status", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const nr = await app.request(`/api/sessions/${session.id}/nodes`);
    const { nodes } = await nr.json();
    const res = await app.request(`/api/sessions/${session.id}/nodes/${nodes[0].id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewStatus: "reviewed-clean", reviewedInUnit: 0 }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).node.reviewStatus).toBe("reviewed-clean");
  });
});

describe("POST /api/sessions/:id/comments", () => {
  it("creates a comment on a node", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const nr = await app.request(`/api/sessions/${session.id}/nodes`);
    const { nodes } = await nr.json();
    const res = await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: nodes[0].id, hunkSnippet: "const x = 1", text: "this looks wrong", structuralContext: "callers: routeHandler" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).comment.text).toBe("this looks wrong");
  });
});

describe("GET /api/sessions/:id/comments", () => {
  it("lists comments in a session", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const nr = await app.request(`/api/sessions/${session.id}/nodes`);
    const { nodes } = await nr.json();
    await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: nodes[0].id, hunkSnippet: "s", text: "comment 1", structuralContext: "callers: A" }),
    });
    const res = await app.request(`/api/sessions/${session.id}/comments`);
    expect(res.status).toBe(200);
    expect((await res.json()).comments).toHaveLength(1);
  });
});

describe("GET /api/sessions/:id/export", () => {
  it("exports comments keyed by node id with structural context", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const nr = await app.request(`/api/sessions/${session.id}/nodes`);
    const { nodes } = await nr.json();
    await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: nodes[0].id, hunkSnippet: "s", text: "fix this", structuralContext: "callers: A, B" }),
    });
    const res = await app.request(`/api/sessions/${session.id}/export`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).length).toBe(1);
    expect(body[nodes[0].id].text).toBe("fix this");
  });
});
