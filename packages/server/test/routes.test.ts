import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DB } from "../src/db/connection.js";
import { createMemoryDatabase } from "../src/db/connection.js";
import { createApp } from "../src/app.js";
import { StubGraphProvider } from "../src/graph/stub.js";
import type { Flow } from "../src/graph/provider.js";

let db: DB;
let app: ReturnType<typeof createApp>;
let fixtureRoot: string;
beforeEach(() => {
  db = createMemoryDatabase();
  // A minimal git repo on "main" so baseRef resolution succeeds by default;
  // tests that need real diffs add commits/changes on top of this.
  fixtureRoot = mkdtempSync(join(tmpdir(), "crw-routes-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: fixtureRoot, encoding: "utf8" });
  g("init", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(fixtureRoot, ".gitkeep"), "");
  g("add", ".");
  g("commit", "-m", "init");
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
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session.id).toBeDefined();
    expect(body.session.branch).toBe("HEAD");
    expect(body.subgraph.nodes.length).toBeGreaterThan(0);
  });

  it("accepts branch HEAD and the checked-out branch", async () => {
    const resHead = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    expect(resHead.status).toBe(200);
    const resMain = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "main", baseRef: "main" }),
    });
    expect(resMain.status).toBe(200);
  });

  it("rejects a branch that is not checked out", async () => {
    const res = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "some-other-branch", baseRef: "HEAD" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/some-other-branch/);
    expect(body.error).toMatch(/main/);
    expect(body.phase).toBe("resolve-ref");
  });

  it("fails with 400 when the repo is unusable", async () => {
    const badRoot = mkdtempSync(join(tmpdir(), "crw-routes-nogit-"));
    const badApp = createApp({ db, graphProvider: new StubGraphProvider(), repoRoot: badRoot });
    try {
      const res = await badApp.request("/api/sessions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/git|ref/i);
      expect(body.phase).toBe("resolve-ref");
    } finally {
      rmSync(badRoot, { recursive: true, force: true });
    }
  });

  it("fails with 400 for an unresolvable baseRef", async () => {
    const res = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "does-not-exist" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/git|ref/i);
    expect(body.phase).toBe("resolve-ref");
  });

  it("fails with 400 and persists no session row when git breaks mid-creation", async () => {
    // Validation passes, then git disappears before residuals run — the
    // GitError path must 400 without leaving an orphaned session row behind.
    class GitBreakingStub extends StubGraphProvider {
      override async getChangeSubgraph(branch: string, baseRef: string) {
        rmSync(join(fixtureRoot, ".git"), { recursive: true, force: true });
        return super.getChangeSubgraph(branch, baseRef);
      }
    }
    const app2 = createApp({ db, graphProvider: new GitBreakingStub(), repoRoot: fixtureRoot });
    const res = await app2.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/git|ref/i);
    expect(body.phase).toBe("list-files");
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM review_sessions").get() as { n: number };
    expect(n).toBe(0);
  });
});

describe("GET /api/sessions/:id", () => {
  it("returns session with units", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
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
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
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

  it("stores multi-entry flow-units with deduped members", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const res = await app.request(`/api/sessions/${session.id}/plan`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        units: [{ kind: "flow", flowEntryStableIds: ["fn:a", "fn:b", "fn:a"], label: "merged" }],
      }),
    });
    const body = await res.json();
    expect(body.units[0].memberStableIds).toEqual(["fn:a", "fn:b"]);
  });
});

describe("GET /api/sessions/:id/nodes", () => {
  it("lists all nodes in a session", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
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
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
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

  it("normalizes reviewed-clean to reviewed-commented when the node has comments", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const sid = session.id;
    const nr = await app.request(`/api/sessions/${sid}/nodes`);
    const { nodes } = await nr.json();
    const nid = nodes[0].id;
    await app.request(`/api/sessions/${sid}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: nid, text: "this looks wrong" }),
    });
    const res = await app.request(`/api/sessions/${sid}/nodes/${nid}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewStatus: "reviewed-clean" }),
    });
    const { node } = await res.json();
    expect(node.reviewStatus).toBe("reviewed-commented");
  });
});

describe("POST /api/sessions/:id/comments", () => {
  it("creates a comment on a node", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const nr = await app.request(`/api/sessions/${session.id}/nodes`);
    const { nodes } = await nr.json();
    const res = await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: nodes[0].id, text: "this looks wrong" }),
    });
    expect(res.status).toBe(200);
    const { comment } = await res.json();
    expect(comment.text).toBe("this looks wrong");
    // The stub graph provider's nodes don't correspond to files on disk, so
    // the server-derived snippet is empty here — real content is covered by
    // the e2e test against a real fixture repo.
    expect(comment.hunkSnippet).toBe("");
    expect(comment.structuralContext).toBe("");
  });

  it("rejects a comment for a node from another session", async () => {
    const crA = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session: sessionA } = await crA.json();
    const crB = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session: sessionB } = await crB.json();
    const nrB = await app.request(`/api/sessions/${sessionB.id}/nodes`);
    const { nodes: nodesB } = await nrB.json();
    const res = await app.request(`/api/sessions/${sessionA.id}/comments`, {
      method: "POST",
      body: JSON.stringify({ nodeId: nodesB[0].id, text: "cross-session" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/sessions/:id/comments", () => {
  it("lists comments in a session", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const nr = await app.request(`/api/sessions/${session.id}/nodes`);
    const { nodes } = await nr.json();
    await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: nodes[0].id, text: "comment 1" }),
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
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
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
  it("exports comments as an ordered array with derived structural context", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const nr = await app.request(`/api/sessions/${session.id}/nodes`);
    const { nodes } = await nr.json();
    const handleOrder = nodes.find((n: any) => n.stableId === "fn:handleOrder");
    await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: handleOrder.id, text: "fix this" }),
    });
    const res = await app.request(`/api/sessions/${session.id}/export`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].nodeId).toBe(handleOrder.id);
    expect(body.comments[0].text).toBe("fix this");
    expect(body.comments[0].startLine).toBe(10);
    expect(body.comments[0].endLine).toBe(30);
    // StubGraphProvider wires fn:handleOrder -> fn:validateOrder, fn:saveOrder.
    expect(body.comments[0].structuralContext).toBe(
      "calls: validateOrder (src/orders.ts:35), saveOrder (src/db.ts:100)"
    );
  });

  it("includes the session's git anchors", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const res = await app.request(`/api/sessions/${session.id}/export`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.branch).toBe("HEAD");
    expect(typeof body.headSha).toBe("string");
    expect(body.baseRef).toBeTruthy();
  });

  it("preserves multiple comments on the same node in creation order", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const nr = await app.request(`/api/sessions/${session.id}/nodes`);
    const { nodes } = await nr.json();
    await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: nodes[0].id, text: "first" }),
    });
    await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: nodes[0].id, text: "second" }),
    });
    const res = await app.request(`/api/sessions/${session.id}/export`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comments).toHaveLength(2);
    expect(body.comments.map((c: any) => c.text)).toEqual(["first", "second"]);
  });
});

describe("GET /api/sessions/:id/flows", () => {
  it("returns flows and the orphan set (changed nodes in no flow)", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
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

class FlowStub extends StubGraphProvider {
  override async getFlows(): Promise<Flow[]> {
    return [{
      id: 1, name: "handleOrder", criticality: 1, depth: 1,
      steps: [
        { stableId: "fn:handleOrder", label: "handleOrder", file: "src/orders.ts", startLine: 10, endLine: 30, isTest: false, depth: 0 },
        { stableId: "fn:validateOrder", label: "validateOrder", file: "src/orders.ts", startLine: 35, endLine: 50, isTest: false, depth: 1 },
        { stableId: "fn:saveOrder", label: "saveOrder", file: "src/db.ts", startLine: 100, endLine: 120, isTest: false, depth: 1 },
      ],
    }];
  }
}

describe("flows route step identity", () => {
  it("exposes stableId per step and changedStableIds per flow", async () => {
    const app2 = createApp({ db, graphProvider: new FlowStub(), repoRoot: fixtureRoot });
    const cr = await app2.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const res = await app2.request(`/api/sessions/${session.id}/flows`);
    const { flows } = await res.json();
    expect(flows[0].steps.map((s: any) => s.stableId)).toEqual(["fn:handleOrder", "fn:validateOrder", "fn:saveOrder"]);
    expect(flows[0].changedStableIds.sort()).toEqual(["fn:handleOrder", "fn:validateOrder"]);
  });
});

class RecordingFlowStub extends FlowStub {
  received: Set<string> | undefined;
  override async getFlows(changedStableIds?: Set<string>): Promise<Flow[]> {
    this.received = changedStableIds;
    return super.getFlows();
  }
}

describe("flows route passes the changed set to the provider", () => {
  it("provides changed session stableIds to getFlows", async () => {
    const provider = new RecordingFlowStub();
    const app2 = createApp({ db, graphProvider: provider, repoRoot: fixtureRoot });
    const cr = await app2.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    await app2.request(`/api/sessions/${session.id}/flows`);
    expect([...(provider.received ?? [])].sort()).toEqual(["fn:handleOrder", "fn:validateOrder"]);
  });
});

describe("residual pseudo-nodes", () => {
  function gitInFixture(...a: string[]) {
    return execFileSync("git", a, { cwd: fixtureRoot, encoding: "utf8" });
  }
  async function makeResidualSession() {
    writeFileSync(join(fixtureRoot, "config.json"), '{\n  "a": 1\n}\n');
    gitInFixture("add", ".");
    gitInFixture("commit", "-m", "base");
    writeFileSync(join(fixtureRoot, "config.json"), '{\n  "a": 2\n}\n');
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
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

  it("reports kind 'file' in the change summary", async () => {
    const session = await makeResidualSession();
    const res = await app.request(`/api/sessions/${session.id}/changes`);
    const { changes } = await res.json();
    const residual = changes.find((ch: any) => ch.stableId === "file-residual:config.json");
    expect(residual.kind).toBe("file");
  });
});

describe("PATCH /api/sessions/:id/units/:unitId", () => {
  async function makePlan() {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const pr = await app.request(`/api/sessions/${session.id}/plan`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ units: [
        { kind: "orphans", orphanStableIds: ["fn:handleOrder"], label: "A" },
        { kind: "orphans", orphanStableIds: ["fn:validateOrder"], label: "B" },
      ] }),
    });
    const { units } = await pr.json();
    return { session, units };
  }

  it("renames a unit", async () => {
    const { session, units } = await makePlan();
    const res = await app.request(`/api/sessions/${session.id}/units/${units[0].id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Renamed" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).units[0].label).toBe("Renamed");
  });

  it("moves a unit and reindexes positions densely", async () => {
    const { session, units } = await makePlan();
    const res = await app.request(`/api/sessions/${session.id}/units/${units[1].id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ position: 0 }),
    });
    const body = await res.json();
    expect(body.units.map((u: any) => u.label)).toEqual(["B", "A"]);
    expect(body.units.map((u: any) => u.position)).toEqual([0, 1]);
  });

  it("rejects edits to the auto unit and 404s unknown units", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    // empty plan → both stub changed nodes swept into the auto unit
    await app.request(`/api/sessions/${session.id}/plan`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ units: [] }),
    });
    const ur = await app.request(`/api/sessions/${session.id}`);
    const autoUnit = (await ur.json()).units.find((u: any) => u.auto);
    const res = await app.request(`/api/sessions/${session.id}/units/${autoUnit.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "nope" }),
    });
    expect(res.status).toBe(400);
    const missing = await app.request(`/api/sessions/${session.id}/units/unit_missing`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "x" }),
    });
    expect(missing.status).toBe(404);
  });
});

describe("stale session indicator", () => {
  it("reports stale=false right after creation and true after HEAD moves", async () => {
    const g = (...a: string[]) => execFileSync("git", a, { cwd: fixtureRoot, encoding: "utf8" });
    writeFileSync(join(fixtureRoot, "a.txt"), "1\n");
    g("add", ".");
    g("commit", "-m", "one");

    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();

    let res = await app.request(`/api/sessions/${session.id}`);
    expect((await res.json()).stale).toBe(false);

    writeFileSync(join(fixtureRoot, "a.txt"), "2\n");
    g("add", ".");
    g("commit", "-m", "two");
    res = await app.request(`/api/sessions/${session.id}`);
    const body = await res.json();
    expect(body.stale).toBe(true);
    expect(body.staleReason).toBe("head-moved");
  });

  it("reports staleReason working-tree-changed after editing a tracked file", async () => {
    const g = (...a: string[]) => execFileSync("git", a, { cwd: fixtureRoot, encoding: "utf8" });
    writeFileSync(join(fixtureRoot, "a.txt"), "1\n");
    g("add", ".");
    g("commit", "-m", "one");

    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();

    // HEAD unchanged, working tree edited → stale by fingerprint.
    writeFileSync(join(fixtureRoot, "a.txt"), "edited\n");
    const res = await app.request(`/api/sessions/${session.id}`);
    const body = await res.json();
    expect(body.stale).toBe(true);
    expect(body.staleReason).toBe("working-tree-changed");
  });

  it("omits stale when git becomes unavailable after session creation", async () => {
    // Session creation requires a working repo; simulate git disappearing
    // afterward (e.g. a broken checkout) and confirm GET still degrades softly.
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    rmSync(join(fixtureRoot, ".git"), { recursive: true, force: true });
    const res = await app.request(`/api/sessions/${session.id}`);
    expect((await res.json()).stale).toBeUndefined();
  });

  it("omits stale (not false) when HEAD matches but the stored fingerprint could not be verified", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();

    db.prepare("UPDATE review_sessions SET repo_fingerprint = '' WHERE id = ?").run(session.id);

    const res = await app.request(`/api/sessions/${session.id}`);
    const body = await res.json();
    expect(body).not.toHaveProperty("stale");
  });
});

describe("runtime validation", () => {
  let sessionId: string;
  let nodeId: string;
  let unitId: string;
  beforeEach(async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    sessionId = session.id;
    const nr = await app.request(`/api/sessions/${sessionId}/nodes`);
    const { nodes } = await nr.json();
    nodeId = nodes[0].id;
    const pr = await app.request(`/api/sessions/${sessionId}/plan`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ units: [{ kind: "orphans", orphanStableIds: ["fn:handleOrder"], label: "A" }] }),
    });
    const { units } = await pr.json();
    unitId = units[0].id;
  });

  it("rejects session creation without branch/baseRef", async () => {
    const res = await app.request("/api/sessions", {
      method: "POST", body: JSON.stringify({}), headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation failed");
    expect(body.issues.map((i: { path: string }) => i.path)).toContain("branch");
  });

  it("rejects invalid JSON bodies", async () => {
    const res = await app.request("/api/sessions", {
      method: "POST", body: "{not json", headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid JSON body");
  });

  it("rejects a plan unit without a label", async () => {
    const res = await app.request(`/api/sessions/${sessionId}/plan`, {
      method: "PUT",
      body: JSON.stringify({ units: [{ kind: "orphans", label: "  ", orphanStableIds: ["fn:validateOrder"] }] }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation failed");
    expect(body.issues).toContainEqual({ path: "units.0.label", message: "unit label must be nonempty" });
  });

  it("rejects a flow unit with no entries", async () => {
    const res = await app.request(`/api/sessions/${sessionId}/plan`, {
      method: "PUT",
      body: JSON.stringify({ units: [{ kind: "flow", label: "Order flow" }] }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation failed");
    expect(body.issues).toContainEqual({ path: "units.0", message: "flow unit needs at least one entry stableId" });
  });

  it("rejects the same stableId claimed by two units", async () => {
    const res = await app.request(`/api/sessions/${sessionId}/plan`, {
      method: "PUT",
      body: JSON.stringify({ units: [
        { kind: "orphans", label: "One", orphanStableIds: ["fn:validateOrder"] },
        { kind: "orphans", label: "Two", orphanStableIds: ["fn:validateOrder"] },
      ] }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation failed");
    expect(body.issues).toContainEqual({
      path: "units.1",
      message: "stableId 'fn:validateOrder' appears in more than one unit",
    });
  });

  it("rejects a plan unit with an unrecognized kind", async () => {
    const res = await app.request(`/api/sessions/${sessionId}/plan`, {
      method: "PUT",
      body: JSON.stringify({ units: [{ kind: "bogus", label: "X" }] }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation failed");
    const issue = body.issues.find((i: { path: string }) => i.path === "units.0.kind");
    expect(issue).toBeDefined();
    expect(issue.message).not.toBe("Invalid input");
    expect(issue.message).toMatch(/discriminator/i);
  });

  it("accepts a flow unit sending both the legacy singular and plural entry fields", async () => {
    const res = await app.request(`/api/sessions/${sessionId}/plan`, {
      method: "PUT",
      body: JSON.stringify({ units: [{
        kind: "flow",
        label: "Order flow",
        flowEntryStableId: "fn:validateOrder",
        flowEntryStableIds: ["fn:validateOrder"],
      }] }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.units[0].memberStableIds).toEqual(["fn:validateOrder"]);
  });

  it("rejects an unknown review status", async () => {
    const res = await app.request(`/api/sessions/${sessionId}/nodes/${nodeId}`, {
      method: "PATCH",
      body: JSON.stringify({ reviewStatus: "looks-fine" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation failed");
    expect(body.issues).toContainEqual({
      path: "reviewStatus",
      message: expect.stringContaining("Invalid option"),
    });
  });

  it("rejects an empty unit patch", async () => {
    const res = await app.request(`/api/sessions/${sessionId}/units/${unitId}`, {
      method: "PATCH", body: JSON.stringify({}), headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation failed");
    expect(body.issues).toContainEqual({ path: "", message: "nothing to update" });
  });

  it("rejects an empty comment", async () => {
    const res = await app.request(`/api/sessions/${sessionId}/comments`, {
      method: "POST",
      body: JSON.stringify({ nodeId, text: "   " }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation failed");
    expect(body.issues).toContainEqual({ path: "text", message: "comment text must be nonempty" });
  });
});

describe("GET /api/sessions/:id/changes", () => {
  it("returns one compact summary per changed node, no diff bodies", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
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
