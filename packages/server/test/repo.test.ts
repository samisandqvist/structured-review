import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DB } from "../src/db/connection.js";
import { createMemoryDatabase } from "../src/db/connection.js";
import { createSession, getSession, updateSessionStatus } from "../src/repo/sessions.js";
import { createUnit, getUnitsBySession, deleteUnit } from "../src/repo/units.js";
import { createNode, getNodesBySession, getNode, getNodeNeighbors, updateNodeReviewStatus } from "../src/repo/nodes.js";
import { createComment, getCommentsBySession, exportComments, structuralContextFor } from "../src/repo/comments.js";

let db: DB;
beforeEach(() => { db = createMemoryDatabase(); });
afterEach(() => { db.close(); });

describe("sessions repo", () => {
  it("creates and retrieves a session", () => {
    const session = createSession(db, "feature-branch", "main");
    expect(session.branch).toBe("feature-branch");
    expect(session.status).toBe("planning");
    expect(getSession(db, session.id)!.branch).toBe("feature-branch");
  });
  it("updates session status", () => {
    const session = createSession(db, "feat", "main");
    updateSessionStatus(db, session.id, "walking");
    expect(getSession(db, session.id)!.status).toBe("walking");
  });
});

describe("units repo", () => {
  it("creates and lists units ordered by position", () => {
    const session = createSession(db, "feat", "main");
    createUnit(db, session.id, 1, "Second", "r2", "orphans", [], false);
    createUnit(db, session.id, 0, "First", "r1", "flow", ["fn:n1"], false);
    const units = getUnitsBySession(db, session.id);
    expect(units).toHaveLength(2);
    expect(units[0].label).toBe("First");
    expect(units[0].memberStableIds).toEqual(["fn:n1"]);
  });
  it("deletes units", () => {
    const session = createSession(db, "feat", "main");
    const unit = createUnit(db, session.id, 0, "Label", "Reason", "flow", [], false);
    deleteUnit(db, unit.id);
    expect(getUnitsBySession(db, session.id)).toHaveLength(0);
  });
});

describe("nodes repo", () => {
  it("creates and retrieves nodes", () => {
    const session = createSession(db, "feat", "main");
    const node = createNode(db, {
      sessionId: session.id, stableId: "fn:handleOrder",
      label: "handleOrder", file: "src/orders.ts", startLine: 10, endLine: 30,
      changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null, isTest: false,
    });
    expect(getNode(db, node.id)).toBeDefined();
    expect(getNodesBySession(db, session.id)).toHaveLength(1);
  });
  it("gets node neighbors via edges", () => {
    const session = createSession(db, "feat", "main");
    const caller = createNode(db, {
      sessionId: session.id, stableId: "fn:caller", label: "caller",
      file: "a.ts", startLine: 1, endLine: 5, changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null, isTest: false,
    });
    const callee = createNode(db, {
      sessionId: session.id, stableId: "fn:callee", label: "callee",
      file: "b.ts", startLine: 1, endLine: 5, changeStatus: "unchanged", reviewStatus: "unreviewed", reviewedInUnit: null, isTest: false,
    });
    db.prepare(
      "INSERT INTO edges (id, session_id, source_node_id, target_node_id, edge_type) VALUES (?, ?, ?, ?, 'call')"
    ).run("e1", session.id, caller.id, callee.id);
    expect(getNodeNeighbors(db, caller.id).callees).toHaveLength(1);
    expect(getNodeNeighbors(db, callee.id).callers).toHaveLength(1);
  });
  it("updates review status", () => {
    const session = createSession(db, "feat", "main");
    const node = createNode(db, {
      sessionId: session.id, stableId: "fn:x", label: "x",
      file: "x.ts", startLine: 1, endLine: 2, changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null, isTest: false,
    });
    updateNodeReviewStatus(db, node.id, "reviewed-clean", 0);
    expect(getNode(db, node.id)!.reviewStatus).toBe("reviewed-clean");
    expect(getNode(db, node.id)!.reviewedInUnit).toBe(0);
  });
});

describe("comments repo", () => {
  it("creates and lists comments", () => {
    const session = createSession(db, "feat", "main");
    const node = createNode(db, {
      sessionId: session.id, stableId: "fn:x", label: "x",
      file: "x.ts", startLine: 1, endLine: 2, changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null, isTest: false,
    });
    createComment(db, session.id, node.id, "snippet", "needs fix", "callers: A");
    expect(getCommentsBySession(db, session.id)).toHaveLength(1);
  });
  it("exports comments as an ordered array, with startLine/endLine and structural context derived from edges", () => {
    const session = createSession(db, "feat", "main");
    const node = createNode(db, {
      sessionId: session.id, stableId: "fn:handleOrder", label: "handleOrder",
      file: "src/orders.ts", startLine: 10, endLine: 30, changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null, isTest: false,
    });
    const caller = createNode(db, {
      sessionId: session.id, stableId: "fn:routeHandler", label: "routeHandler",
      file: "src/routes.ts", startLine: 1, endLine: 5, changeStatus: "unchanged", reviewStatus: "unreviewed", reviewedInUnit: null, isTest: false,
    });
    db.prepare("INSERT INTO edges (id, session_id, source_node_id, target_node_id, edge_type) VALUES (?, ?, ?, ?, 'call')")
      .run("e1", session.id, caller.id, node.id);
    // Stored structuralContext ("stale value") is ignored on export — it is
    // always recomputed from the session's edges at export time.
    createComment(db, session.id, node.id, "old", "bug here", "stale value");
    const exported = exportComments(db, session.id);
    expect(exported).toHaveLength(1);
    expect(exported[0].stableId).toBe("fn:handleOrder");
    expect(exported[0].startLine).toBe(10);
    expect(exported[0].endLine).toBe(30);
    expect(exported[0].structuralContext).toBe("called by: routeHandler (src/routes.ts:1)");
  });
  it("preserves multiple comments on one node in creation order", () => {
    const session = createSession(db, "feat", "main");
    const node = createNode(db, {
      sessionId: session.id, stableId: "fn:handleOrder", label: "handleOrder",
      file: "src/orders.ts", startLine: 10, endLine: 30, changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null, isTest: false,
    });
    createComment(db, session.id, node.id, "snippetA", "first", "ctxA");
    createComment(db, session.id, node.id, "snippetB", "second", "ctxB");
    const exported = exportComments(db, session.id);
    expect(exported).toHaveLength(2);
    expect(exported.map((c) => c.text)).toEqual(["first", "second"]);
    expect(exported[0].nodeId).toBe(node.id);
    expect(exported[0].stableId).toBe(node.stableId);
  });
});

describe("structuralContextFor", () => {
  it("structuralContextFor lists callers, callees, and tests", () => {
    const db = createMemoryDatabase();
    const session = createSession(db, "HEAD", "main", "sha", "fp");
    const base = { sessionId: session.id, startLine: 1, endLine: 5, changeStatus: "changed" as const, reviewStatus: "unreviewed" as const, reviewedInUnit: null, isTest: false };
    const a = createNode(db, { ...base, stableId: "fn:a", label: "a", file: "src/a.ts" });
    const b = createNode(db, { ...base, stableId: "fn:b", label: "b", file: "src/b.ts" });
    const c = createNode(db, { ...base, stableId: "fn:c", label: "c", file: "src/c.ts" });
    const t = createNode(db, { ...base, stableId: "fn:t", label: "t", file: "test/t.ts", isTest: true });
    const addEdge = db.prepare("INSERT INTO edges (id, session_id, source_node_id, target_node_id, edge_type) VALUES (?, ?, ?, ?, ?)");
    addEdge.run("e1", session.id, b.id, a.id, "call"); // b calls a
    addEdge.run("e2", session.id, a.id, c.id, "call"); // a calls c
    addEdge.run("e3", session.id, t.id, a.id, "test"); // t tests a
    expect(structuralContextFor(db, a.id)).toBe(
      "called by: b (src/b.ts:1); calls: c (src/c.ts:1); tested by: t (test/t.ts:1)"
    );
  });
});

describe("units repo (kind-tagged)", () => {
  it("round-trips kind, memberStableIds, and auto", () => {
    const s = createSession(db, "feat", "main");
    createUnit(db, s.id, 0, "Order flow", "the order path", "flow", ["fn:handleOrder"], false);
    createUnit(db, s.id, 1, "Unassigned changes", "leftovers", "orphans", ["fn:x"], true);
    const units = getUnitsBySession(db, s.id);
    expect(units[0]).toMatchObject({ kind: "flow", memberStableIds: ["fn:handleOrder"], auto: false });
    expect(units[1]).toMatchObject({ kind: "orphans", memberStableIds: ["fn:x"], auto: true });
  });
});
