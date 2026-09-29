// Edge persistence: graph edges are stored per session with their reference
// weight, and test edges come back for attachment derivation.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DB } from "../src/db/connection.js";
import { createMemoryDatabase } from "../src/db/connection.js";
import { createSession } from "../src/repo/sessions.js";
import { createNode } from "../src/repo/nodes.js";
import { insertEdges, getTestEdges } from "../src/repo/edges.js";

let db: DB;
beforeEach(() => {
  db = createMemoryDatabase();
});
afterEach(() => {
  db.close();
});

function seedNode(sessionId: string, stableId: string, isTest: boolean) {
  return createNode(db, {
    sessionId,
    stableId,
    label: stableId,
    file: `${stableId}.ts`,
    startLine: 1,
    endLine: 5,
    changeStatus: "changed",
    reviewStatus: "unreviewed",
    reviewedInUnit: null,
    isTest,
  });
}

describe("edges repo", () => {
  it("stores the edge weight and returns it on test edges", () => {
    const session = createSession(db, "HEAD", "main");
    const prod = seedNode(session.id, "fn:resolve", false);
    const test = seedNode(session.id, "mod:claims.test.ts", true);
    const idByStable = new Map([
      [prod.stableId, prod.id],
      [test.stableId, test.id],
    ]);
    insertEdges(
      db,
      session.id,
      [{ sourceStableId: prod.stableId, targetStableId: test.stableId, edgeType: "test", weight: 6 }],
      idByStable,
    );
    expect(getTestEdges(db, session.id)).toEqual([
      { productionStableId: "fn:resolve", testStableId: "mod:claims.test.ts", weight: 6 },
    ]);
  });

  it("an edge without a weight is stored as one reference", () => {
    const session = createSession(db, "HEAD", "main");
    const prod = seedNode(session.id, "fn:a", false);
    const test = seedNode(session.id, "fn:aSpec", true);
    const idByStable = new Map([
      [prod.stableId, prod.id],
      [test.stableId, test.id],
    ]);
    insertEdges(db, session.id, [{ sourceStableId: "fn:a", targetStableId: "fn:aSpec", edgeType: "test" }], idByStable);
    expect(getTestEdges(db, session.id)).toEqual([{ productionStableId: "fn:a", testStableId: "fn:aSpec", weight: 1 }]);
  });

  it("skips edges whose endpoints are not session nodes and ignores call edges on read", () => {
    const session = createSession(db, "HEAD", "main");
    const a = seedNode(session.id, "fn:a", false);
    const b = seedNode(session.id, "fn:b", false);
    const idByStable = new Map([
      [a.stableId, a.id],
      [b.stableId, b.id],
    ]);
    insertEdges(
      db,
      session.id,
      [
        { sourceStableId: "fn:a", targetStableId: "fn:b", edgeType: "call" },
        { sourceStableId: "fn:a", targetStableId: "fn:missing", edgeType: "test" },
      ],
      idByStable,
    );
    expect(getTestEdges(db, session.id)).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM edges").get() as { n: number }).n).toBe(1);
  });
});
