import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DB } from "../src/db/connection.js";
import { createMemoryDatabase } from "../src/db/connection.js";
import { createApp } from "../src/app.js";
import { StubGraphProvider } from "../src/graph/stub.js";

let db: DB;
let app: ReturnType<typeof createApp>;
let fixtureRoot: string;
beforeEach(() => {
  db = createMemoryDatabase();
  // Not a git repo → diff helpers see no changes; sessions behave as before.
  fixtureRoot = mkdtempSync(join(tmpdir(), "crw-routes-"));
  app = createApp({ db, graphProvider: new StubGraphProvider(), repoRoot: fixtureRoot });
});
afterEach(() => {
  db.close();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

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
  it("replaces the plan with kind-tagged units", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const res = await app.request(`/api/sessions/${session.id}/plan`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        units: [
          { kind: "flow", flowEntryStableId: "fn:handleOrder", label: "Order handling", rationale: "the order path" },
          { kind: "orphans", orphanStableIds: ["fn:validateOrder"], label: "Validation helpers" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.units.length).toBeGreaterThanOrEqual(2);
    expect(body.units[0].kind).toBe("flow");
    expect(body.units[0].memberStableIds).toEqual(["fn:handleOrder"]);
    expect(body.units[1].kind).toBe("orphans");
    expect(body.units[1].memberStableIds).toEqual(["fn:validateOrder"]);
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

describe("coverage reconciliation", () => {
  it("sweeps uncovered changed nodes into an auto Unassigned unit and reports coverage", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    // Stub flows = [], so an orphan-unit covering one changed node leaves the rest unassigned.
    const res = await app.request(`/api/sessions/${session.id}/plan`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ units: [{ kind: "orphans", orphanStableIds: ["fn:handleOrder"], label: "Orders" }] }),
    });
    const body = await res.json();
    expect(body.coverage.changedTotal).toBe(2); // fn:handleOrder + fn:validateOrder are "changed" in the stub
    expect(body.coverage.covered).toBe(1);
    expect(body.coverage.unassigned).toBe(1);
    const auto = body.units.find((u: any) => u.auto);
    expect(auto.label).toBe("Unassigned changes");
    expect(auto.memberStableIds).toEqual(["fn:validateOrder"]);

    const sres = await app.request(`/api/sessions/${session.id}`);
    expect((await sres.json()).coverage).toEqual({ changedTotal: 2, covered: 1, unassigned: 1 });
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

describe("GET /api/sessions/:id/flows", () => {
  it("returns flows and the orphan set (changed nodes in no flow)", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const res = await app.request(`/api/sessions/${session.id}/flows`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.flows)).toBe(true);
    // stub has no flows → both changed nodes are orphans
    expect(body.orphans.map((n: any) => n.stableId).sort()).toEqual(["fn:handleOrder", "fn:validateOrder"]);
  });
});

describe("residual pseudo-nodes", () => {
  function gitInFixture(...a: string[]) {
    return execFileSync("git", a, { cwd: fixtureRoot, encoding: "utf8" });
  }
  async function makeResidualSession() {
    gitInFixture("init", "-b", "main");
    gitInFixture("config", "user.email", "t@t");
    gitInFixture("config", "user.name", "t");
    writeFileSync(join(fixtureRoot, "config.json"), '{\n  "a": 1\n}\n');
    gitInFixture("add", ".");
    gitInFixture("commit", "-m", "base");
    writeFileSync(join(fixtureRoot, "config.json"), '{\n  "a": 2\n}\n');
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    return session as { id: string };
  }

  it("stores a file-residual node for changed lines outside any graph node", async () => {
    const session = await makeResidualSession();
    const nr = await app.request(`/api/sessions/${session.id}/nodes`);
    const { nodes } = await nr.json();
    const residual = nodes.find((n: any) => n.stableId === "file-residual:config.json");
    expect(residual).toBeDefined();
    expect(residual.changeStatus).toBe("changed");
    expect(residual.label).toBe("config.json");

    // and it participates in coverage
    const sres = await app.request(`/api/sessions/${session.id}`);
    const { coverage } = await sres.json();
    expect(coverage.changedTotal).toBe(3); // 2 stub changed nodes + 1 residual
  });
});

describe("GET /api/sessions/:id/changes", () => {
  it("returns one compact summary per changed node, no diff bodies", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const res = await app.request(`/api/sessions/${session.id}/changes`);
    expect(res.status).toBe(200);
    const { changes } = await res.json();
    expect(changes.map((c: any) => c.stableId).sort()).toEqual(["fn:handleOrder", "fn:validateOrder"]);
    for (const ch of changes) {
      expect(ch).toHaveProperty("added");
      expect(ch).toHaveProperty("removed");
      expect(ch).toHaveProperty("signature");
      expect(ch.kind).toBe("function");
      expect(ch).not.toHaveProperty("oldText");
      expect(ch).not.toHaveProperty("newText");
    }
  });
});
