import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DB } from "../src/db/connection.js";
import { createMemoryDatabase } from "../src/db/connection.js";
import { createApp } from "../src/app.js";
import { StubGraphProvider } from "../src/graph/stub.js";
import type { Flow, ChangeSubgraph, GraphProvider } from "../src/graph/provider.js";
import { IndexError } from "../src/graph/scip.js";

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

  it("fails with 400 and phase 'index' when an indexer breaks, persisting nothing", async () => {
    class IndexBreakingStub extends StubGraphProvider {
      override async getChangeSubgraph(): Promise<ChangeSubgraph> {
        throw new IndexError("py indexer failed for root 'svc': exit 1");
      }
    }
    const app2 = createApp({ db, graphProvider: new IndexBreakingStub(), repoRoot: fixtureRoot });
    const res = await app2.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.phase).toBe("index");
    expect(body.error).toMatch(/py indexer failed/);
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM review_sessions").get() as { n: number };
    expect(n).toBe(0);
  });

  it("persists and returns index warnings from the graph provider", async () => {
    const warning = "Java indexing skipped for 1 root(s) ('introspector'): scip-java toolchain not found.";
    const stub = new StubGraphProvider() as StubGraphProvider & { getIndexWarnings(): Promise<string[]> };
    stub.getIndexWarnings = async () => [warning];
    const warnApp = createApp({ db, graphProvider: stub, repoRoot: fixtureRoot });
    const cr = await warnApp.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    expect(cr.status).toBe(200);
    const { session } = await cr.json();
    expect(session.indexWarnings).toEqual([warning]);
    const res = await warnApp.request(`/api/sessions/${session.id}`);
    const body = await res.json();
    expect(body.session.indexWarnings).toEqual([warning]);
  });

  it("returns empty index warnings when the provider reports none", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    expect(session.indexWarnings).toEqual([]);
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

describe("GET /api/sessions (list)", () => {
  it("lists sessions newest first", async () => {
    const empty = await (await app.request("/api/sessions")).json();
    expect(empty.sessions).toEqual([]);
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const body = await (await app.request("/api/sessions")).json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toContain(session.id);
  });
});

describe("DELETE /api/sessions/:id", () => {
  it("deletes the session and cascades its nodes and comments", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const { nodes } = await (await app.request(`/api/sessions/${session.id}/nodes`)).json();
    expect(nodes.length).toBeGreaterThan(0);
    await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: nodes[0].id, text: "gone soon" }),
    });

    const del = await app.request(`/api/sessions/${session.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await del.json()).deleted).toBe(session.id);

    expect((await app.request(`/api/sessions/${session.id}`)).status).toBe(404);
    const orphanRows = db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE session_id = ?").get(session.id) as { c: number };
    expect(orphanRows.c).toBe(0);
    const commentRows = db.prepare("SELECT COUNT(*) AS c FROM comments WHERE session_id = ?").get(session.id) as { c: number };
    expect(commentRows.c).toBe(0);
  });

  it("returns 404 for an unknown session", async () => {
    const res = await app.request("/api/sessions/nonexistent", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/shutdown", () => {
  it("reports unsupported when no shutdown handler is wired (tests)", async () => {
    const res = await app.request("/api/shutdown", { method: "POST" });
    expect(res.status).toBe(501);
  });

  it("responds ok and invokes the handler when wired", async () => {
    let called = false;
    const stoppable = createApp({
      db, graphProvider: new StubGraphProvider(), repoRoot: fixtureRoot,
      onShutdown: () => { called = true; },
    });
    const res = await stoppable.request("/api/shutdown", { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 250));
    expect(called).toBe(true);
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

  it("stores a trimmed overview, returns it, and clears it on resubmit without one", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const units = [{ kind: "flow", flowEntryStableId: "fn:handleOrder", label: "Order handling" }];

    const res = await app.request(`/api/sessions/${session.id}/plan`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overview: "  Adds Redis rate limiting; units 1-2 are the config foundation.  ", units }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).overview).toBe("Adds Redis rate limiting; units 1-2 are the config foundation.");

    const info = await (await app.request(`/api/sessions/${session.id}`)).json();
    expect(info.session.overview).toBe("Adds Redis rate limiting; units 1-2 are the config foundation.");

    const res2 = await app.request(`/api/sessions/${session.id}/plan`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ units }),
    });
    expect((await res2.json()).overview).toBe("");
    const info2 = await (await app.request(`/api/sessions/${session.id}`)).json();
    expect(info2.session.overview).toBe("");
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

describe("bulk node status", () => {
  async function makeSessionWithTwoNodes() {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const nr = await app.request(`/api/sessions/${session.id}/nodes`);
    const { nodes } = await nr.json();
    return { sessionId: session.id as string, id1: nodes[0].id as string, id2: nodes[1].id as string };
  }

  it("PATCH /nodes updates several nodes atomically", async () => {
    const { sessionId, id1, id2 } = await makeSessionWithTwoNodes();
    const res = await app.request(`/api/sessions/${sessionId}/nodes`, {
      method: "PATCH",
      body: JSON.stringify({ nodeIds: [id1, id2], reviewStatus: "reviewed-clean" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes).toHaveLength(2);
    expect(body.nodes.every((n: { reviewStatus: string }) => n.reviewStatus === "reviewed-clean")).toBe(true);
  });

  it("404s with the missing ids and writes nothing on a bad id", async () => {
    const { sessionId, id1 } = await makeSessionWithTwoNodes();
    const res = await app.request(`/api/sessions/${sessionId}/nodes`, {
      method: "PATCH",
      body: JSON.stringify({ nodeIds: [id1, "node_nope"], reviewStatus: "reviewed-clean" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).missingNodeIds).toEqual(["node_nope"]);
    const after = await (await app.request(`/api/sessions/${sessionId}/nodes`)).json();
    expect(after.nodes.find((n: { id: string }) => n.id === id1).reviewStatus).toBe("unreviewed");
  });

  it("rejects an empty nodeIds array", async () => {
    const { sessionId } = await makeSessionWithTwoNodes();
    const res = await app.request(`/api/sessions/${sessionId}/nodes`, {
      method: "PATCH",
      body: JSON.stringify({ nodeIds: [], reviewStatus: "reviewed-clean" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("validation failed");
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

describe("session-wide comments", () => {
  async function makeSession() {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    return (await cr.json()).session;
  }

  it("creates a comment with no nodeId and lists it with nodeId null", async () => {
    const session = await makeSession();
    const res = await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "missing tests for the retry path" }),
    });
    expect(res.status).toBe(200);
    const { comment } = await res.json();
    expect(comment.nodeId).toBeNull();
    expect(comment.hunkSnippet).toBe("");
    const list = await (await app.request(`/api/sessions/${session.id}/comments`)).json();
    expect(list.comments[0].nodeId).toBeNull();
  });

  it("rejects an anchor without a nodeId", async () => {
    const session = await makeSession();
    const res = await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "anchored to nothing",
        anchor: { startLine: 1, startSide: "new", endLine: 1, endSide: "new" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("exports session comments with scope:'session' and node comments with scope:'node'", async () => {
    const session = await makeSession();
    const { nodes } = await (await app.request(`/api/sessions/${session.id}/nodes`)).json();
    await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: nodes[0].id, text: "inline" }),
    });
    await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "review-wide" }),
    });
    const exported = await (await app.request(`/api/sessions/${session.id}/export`)).json();
    expect(exported.comments).toHaveLength(2);
    const inline = exported.comments.find((c: any) => c.scope === "node");
    const wide = exported.comments.find((c: any) => c.scope === "session");
    expect(inline.file).toBeDefined();
    expect(inline.nodeId).toBe(nodes[0].id);
    expect(wide.text).toBe("review-wide");
    expect(wide.nodeId).toBeUndefined();
    expect(wide.file).toBeUndefined();
  });
});

describe("coverage reconciliation", () => {
  it("attaches same-file leftovers to their covered sibling and reports them covered", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    // Stub flows = []; fn:validateOrder is unassigned but shares src/orders.ts
    // with the covered fn:handleOrder, so it attaches instead of sweeping.
    const res = await app.request(`/api/sessions/${session.id}/plan`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ units: [{ kind: "orphans", orphanStableIds: ["fn:handleOrder"], label: "Orders" }] }),
    });
    const body = await res.json();
    expect(body.coverage).toEqual({ changedTotal: 2, covered: 2, unassigned: 0 });
    expect(body.units.find((u: any) => u.auto)).toBeUndefined();
    expect(body.units[0].attached).toEqual([
      { stableId: "fn:validateOrder", parentStableId: "fn:handleOrder", reason: "same-file", counted: true },
    ]);

    const sres = await app.request(`/api/sessions/${session.id}`);
    expect((await sres.json()).coverage).toEqual({ changedTotal: 2, covered: 2, unassigned: 0 });
  });

  it("sweeps unattachable changed nodes into the auto Unassigned unit", async () => {
    // A changed node in its own file with no test edge and no requires
    // relation cannot attach anywhere — it must still be swept.
    class LonelyStub extends StubGraphProvider {
      async getChangeSubgraph(branch: string, baseRef: string) {
        const sg = await super.getChangeSubgraph(branch, baseRef);
        return {
          ...sg,
          nodes: [...sg.nodes, {
            stableId: "fn:lonely", label: "lonely", file: "src/lonely.ts",
            startLine: 1, endLine: 5, isEntryPoint: false,
            changeStatus: "changed" as const, isTest: false,
          }],
        };
      }
    }
    const lonelyApp = createApp({ db, graphProvider: new LonelyStub(), repoRoot: fixtureRoot });
    const cr = await lonelyApp.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const res = await lonelyApp.request(`/api/sessions/${session.id}/plan`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ units: [{ kind: "orphans", orphanStableIds: ["fn:handleOrder"], label: "Orders" }] }),
    });
    const body = await res.json();
    expect(body.coverage).toEqual({ changedTotal: 3, covered: 2, unassigned: 1 });
    const auto = body.units.find((u: any) => u.auto);
    expect(auto.label).toBe("Unassigned changes");
    expect(auto.memberStableIds).toEqual(["fn:lonely"]);
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

  it("export includes the session overview, empty string when unset", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    expect((await (await app.request(`/api/sessions/${session.id}/export`)).json()).overview).toBe("");

    await app.request(`/api/sessions/${session.id}/plan`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        overview: "One-line narrative.",
        units: [{ kind: "flow", flowEntryStableId: "fn:handleOrder", label: "Order handling" }],
      }),
    });
    expect((await (await app.request(`/api/sessions/${session.id}/export`)).json()).overview).toBe("One-line narrative.");
  });
});

describe("GET /api/sessions/:id/nodes/:nodeId/context", () => {
  async function sessionWithFile() {
    // Real file on disk so the working-tree read has content to serve.
    mkdirSync(join(fixtureRoot, "src"), { recursive: true });
    writeFileSync(
      join(fixtureRoot, "src", "orders.ts"),
      Array.from({ length: 40 }, (_, i) => `line${i + 1}`).join("\n") + "\n"
    );
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const { nodes } = await (await app.request(`/api/sessions/${session.id}/nodes`)).json();
    return { session, node: nodes.find((n: any) => n.stableId === "fn:handleOrder") };
  }

  it("serves working-tree context lines for a range", async () => {
    const { session, node } = await sessionWithFile();
    const res = await app.request(`/api/sessions/${session.id}/nodes/${node.id}/context?start=1&end=3`);
    expect(res.status).toBe(200);
    const { lines } = await res.json();
    expect(lines.map((l: any) => l.text)).toEqual(["line1", "line2", "line3"]);
    expect(lines[0]).toMatchObject({ type: "context", newLine: 1 });
  });

  it("rejects bad ranges and oversized ranges", async () => {
    const { session, node } = await sessionWithFile();
    for (const q of ["start=0&end=3", "start=5&end=2", "start=abc&end=3", "start=1&end=6000"]) {
      const res = await app.request(`/api/sessions/${session.id}/nodes/${node.id}/context?${q}`);
      expect(res.status).toBe(400);
    }
  });

  it("404s for a node outside the session", async () => {
    const { session } = await sessionWithFile();
    const res = await app.request(`/api/sessions/${session.id}/nodes/nope/context?start=1&end=2`);
    expect(res.status).toBe(404);
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

  it("round-trips the residual node's exact ranges", async () => {
    const session = await makeResidualSession();
    const nr = await app.request(`/api/sessions/${session.id}/nodes`);
    const { nodes } = await nr.json();
    const residual = nodes.find((n: any) => n.stableId === "file-residual:config.json");
    expect(Array.isArray(residual.residualRanges)).toBe(true);
    expect(residual.residualRanges.length).toBeGreaterThan(0);
    for (const r of residual.residualRanges) {
      expect(typeof r.start).toBe("number");
      expect(typeof r.end).toBe("number");
    }
  });

  it("creates an anchored comment on a residual node using its residual-ranges diff, and rejects an unresolvable anchor", async () => {
    const session = await makeResidualSession();
    const nr = await app.request(`/api/sessions/${session.id}/nodes`);
    const { nodes } = await nr.json();
    const residual = nodes.find((n: any) => n.stableId === "file-residual:config.json");
    expect(residual).toBeDefined();

    // Fetch the residual node's diff exactly as the diff pane would (getNodeDiffForRanges).
    const diffRes = await app.request(`/api/sessions/${session.id}/nodes/${residual.id}`);
    expect(diffRes.status).toBe(200);
    const { diff } = await diffRes.json();
    const added = diff.lines.find((l: { type: string }) => l.type === "added");
    expect(added).toBeDefined();

    const anchor = { startLine: added.newLine, startSide: "new", endLine: added.newLine, endSide: "new" };
    const res = await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: residual.id, text: "residual anchor", anchor }),
    });
    expect(res.status).toBe(200);
    const { comment } = await res.json();
    expect(comment.anchor).toEqual(anchor);
    expect(comment.hunkSnippet).toContain(added.text);
    expect(comment.hunkSnippet.split("\n")).toHaveLength(1); // single-line anchor -> one snippet row

    // A line outside the residual node's diff entirely must not resolve.
    const badRes = await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodeId: residual.id, text: "bad",
        anchor: { startLine: 99999, startSide: "new", endLine: 99999, endSide: "new" },
      }),
    });
    expect(badRes.status).toBe(400);
    const badBody = await badRes.json();
    expect(badBody.error).toMatch(/anchor/i);
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

describe("anchored comments", () => {
  // The stub's fn:handleOrder points at src/orders.ts lines 10-30. Commit a
  // 55-line base (advancing main = baseRef), then insert one line inside that
  // span so `git diff main` yields an added line at new-file line 15, keeping
  // the node "changed" with a real diff to anchor into.
  const STUB_FILE = "src/orders.ts";
  const BASE_LINES = Array.from({ length: 55 }, (_, i) => `line ${i + 1}`);
  const BASE_CONTENT = BASE_LINES.join("\n") + "\n";
  const MODIFIED_CONTENT =
    [...BASE_LINES.slice(0, 14), "const inserted = true;", ...BASE_LINES.slice(14)].join("\n") + "\n";

  async function makeSessionWithDiff() {
    const g = (...a: string[]) => execFileSync("git", a, { cwd: fixtureRoot, encoding: "utf8" });
    mkdirSync(join(fixtureRoot, "src"), { recursive: true });
    writeFileSync(join(fixtureRoot, STUB_FILE), BASE_CONTENT);
    g("add", ".");
    g("commit", "-m", "base");
    writeFileSync(join(fixtureRoot, STUB_FILE), MODIFIED_CONTENT); // adds a line inside the node span
    const res = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await res.json();
    const nodesRes = await app.request(`/api/sessions/${session.id}/nodes`);
    const { nodes } = await nodesRes.json();
    return { session, node: nodes.find((n: { changeStatus: string }) => n.changeStatus === "changed") };
  }

  it("creates an anchored comment with a range-scoped snippet and exports the anchor", async () => {
    const { session, node } = await makeSessionWithDiff();
    // find an added line to anchor on via the node diff endpoint
    const diffRes = await app.request(`/api/sessions/${session.id}/nodes/${node.id}`);
    const { diff } = await diffRes.json();
    const added = diff.lines.find((l: { type: string }) => l.type === "added");
    expect(added).toBeDefined();
    const anchor = { startLine: added.newLine, startSide: "new", endLine: added.newLine, endSide: "new" };
    const res = await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: node.id, text: "anchored!", anchor }),
    });
    expect(res.status).toBe(200);
    const { comment } = await res.json();
    expect(comment.anchor).toEqual(anchor);
    expect(comment.hunkSnippet).toContain(added.text);
    expect(comment.hunkSnippet.split("\n")).toHaveLength(1); // range-scoped: just the anchored row

    const exportRes = await app.request(`/api/sessions/${session.id}/export`);
    const exported = await exportRes.json();
    expect(exported.comments.find((c: { id: string }) => c.id === comment.id).anchor).toEqual(anchor);
  });

  it("rejects an anchor that does not resolve (context line / absent line)", async () => {
    const { session, node } = await makeSessionWithDiff();
    const res = await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: node.id, text: "bad", anchor: { startLine: 99999, startSide: "new", endLine: 99999, endSide: "new" } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/anchor/i);
  });

  it("rejects a half-specified anchor at the schema layer", async () => {
    const { session, node } = await makeSessionWithDiff();
    const res = await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: node.id, text: "bad", anchor: { startLine: 1, startSide: "new" } }),
    });
    expect(res.status).toBe(400);
  });

  it("node-level comments still work with a whole-node snippet", async () => {
    const { session, node } = await makeSessionWithDiff();
    const res = await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: node.id, text: "node-level" }),
    });
    expect(res.status).toBe(200);
    const { comment } = await res.json();
    expect(comment.anchor).toBeNull();
  });

  it("rejects an anchor that addresses a context line rather than a changed line", async () => {
    const { session, node } = await makeSessionWithDiff();
    const diffRes = await app.request(`/api/sessions/${session.id}/nodes/${node.id}`);
    const { diff } = await diffRes.json();
    // The insertion is surrounded by unified=3 context rows within the node span.
    const context = diff.lines.find((l: { type: string; newLine: number | null }) => l.type === "context" && l.newLine != null);
    expect(context).toBeDefined();
    const res = await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodeId: node.id, text: "bad",
        anchor: { startLine: context.newLine, startSide: "new", endLine: context.newLine, endSide: "new" },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/anchor/i);
  });

  // The shared makeSessionWithDiff() fixture inserts only a single line, so it
  // has just one addressable changed line — not enough to build a genuinely
  // inverted range. Insert two lines within the node's span instead, far
  // enough apart to land in separate hunks, giving two real added lines to
  // invert.
  async function makeSessionWithTwoAddedLines() {
    const g = (...a: string[]) => execFileSync("git", a, { cwd: fixtureRoot, encoding: "utf8" });
    mkdirSync(join(fixtureRoot, "src"), { recursive: true });
    writeFileSync(join(fixtureRoot, STUB_FILE), BASE_CONTENT);
    g("add", ".");
    g("commit", "-m", "base");
    const part1 = BASE_LINES.slice(0, 12);
    const part2 = BASE_LINES.slice(12, 20);
    const part3 = BASE_LINES.slice(20);
    const modified = [...part1, "const first = 1;", ...part2, "const second = 2;", ...part3].join("\n") + "\n";
    writeFileSync(join(fixtureRoot, STUB_FILE), modified);
    const res = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await res.json();
    const nodesRes = await app.request(`/api/sessions/${session.id}/nodes`);
    const { nodes } = await nodesRes.json();
    return { session, node: nodes.find((n: { changeStatus: string }) => n.changeStatus === "changed") };
  }

  it("rejects an inverted anchor range (start after end)", async () => {
    const { session, node } = await makeSessionWithTwoAddedLines();
    const diffRes = await app.request(`/api/sessions/${session.id}/nodes/${node.id}`);
    const { diff } = await diffRes.json();
    const added = diff.lines.filter((l: { type: string }) => l.type === "added");
    expect(added.length).toBeGreaterThanOrEqual(2);
    const [first, second] = added; // in-file order: first.newLine < second.newLine
    expect(first.newLine).toBeLessThan(second.newLine);
    const res = await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodeId: node.id, text: "bad",
        // start = the later line, end = the earlier line -> inverted row order
        anchor: { startLine: second.newLine, startSide: "new", endLine: first.newLine, endSide: "new" },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/anchor/i);
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

  it("classifies python #-method stableIds as methods and plain callables as functions", async () => {
    const pyProvider: GraphProvider = {
      async getChangeSubgraph(): Promise<ChangeSubgraph> {
        return {
          nodes: [
            { stableId: "scip-python python svc 0.0.1 `app`/main().", label: "main", file: "app.py", startLine: 1, endLine: 3, isEntryPoint: true, changeStatus: "changed", isTest: false },
            { stableId: "scip-python python svc 0.0.1 `app`/Client#send().", label: "send", file: "app.py", startLine: 5, endLine: 8, isEntryPoint: false, changeStatus: "changed", isTest: false },
          ],
          edges: [],
        };
      },
      async getFlows() { return []; },
      async getNeighbors() { return { callers: [], callees: [] }; },
    };
    const pyApp = createApp({ db, graphProvider: pyProvider, repoRoot: fixtureRoot });
    const cr = await pyApp.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const res = await pyApp.request(`/api/sessions/${session.id}/changes`);
    const { changes } = await res.json();
    const byLabel = Object.fromEntries(changes.map((c: any) => [c.label, c.kind]));
    expect(byLabel).toEqual({ main: "function", send: "method" });
  });
});
