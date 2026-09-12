import { describe, it, expect } from "vitest";

import { createMemoryDatabase, createUnmigratedMemoryDatabase, migrate } from "../src/db/connection.js";
import { SCHEMA_VERSION, MIGRATIONS } from "../src/db/schema.js";

describe("schema", () => {
  it("creates all tables", () => {
    const db = createMemoryDatabase();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("review_sessions");
    expect(names).toContain("units");
    expect(names).toContain("nodes");
    expect(names).toContain("edges");
    expect(names).toContain("comments");
    db.close();
  });

  it("enforces foreign keys", () => {
    const db = createMemoryDatabase();
    expect(() =>
      db
        .prepare("INSERT INTO units (id, session_id, position, label, rationale) VALUES (?, ?, ?, ?, ?)")
        .run("u1", "nonexistent", 0, "test", "test"),
    ).toThrow();
    db.close();
  });

  it("stamps a fresh database with SCHEMA_VERSION", () => {
    const db = createMemoryDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("migrates a version-0 database with existing tables to current", () => {
    const db = createUnmigratedMemoryDatabase();
    db.exec(
      "CREATE TABLE IF NOT EXISTS review_sessions (id TEXT PRIMARY KEY, branch TEXT NOT NULL, base_ref TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'planning', created_at INTEGER NOT NULL, head_sha TEXT NOT NULL DEFAULT '')",
    );
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    expect(() => migrate(db)).not.toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("adds repo_fingerprint via the v2 migration", () => {
    const db = createMemoryDatabase();
    const cols = (db.pragma("table_info(review_sessions)") as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("repo_fingerprint");
    db.close();
  });

  it("adds overview via the v9 migration", () => {
    const db = createMemoryDatabase();
    const cols = (db.pragma("table_info(review_sessions)") as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("overview");
    db.close();
  });

  it("throws a clear error when a migration in the upgrade path is missing", () => {
    const saved = MIGRATIONS[SCHEMA_VERSION];
    delete MIGRATIONS[SCHEMA_VERSION];
    try {
      const db = createUnmigratedMemoryDatabase();
      expect(() => migrate(db)).toThrow(new RegExp(`migration.*${SCHEMA_VERSION}`, "i"));
      db.close();
    } finally {
      MIGRATIONS[SCHEMA_VERSION] = saved;
    }
  });

  it("rejects a database newer than the application", () => {
    const db = createUnmigratedMemoryDatabase();
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    expect(() => migrate(db)).toThrow(/newer/i);
    db.close();
  });

  it("adds nodes.residual_ranges via the v3 migration, NULL for existing rows", () => {
    const db = createUnmigratedMemoryDatabase();
    db.exec(MIGRATIONS[1]);
    db.exec(MIGRATIONS[2]);
    db.pragma("user_version = 2");
    db.prepare(
      "INSERT INTO review_sessions (id, branch, base_ref, status, created_at, head_sha, repo_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("s1", "main", "main", "planning", 0, "", "");
    db.prepare(
      "INSERT INTO nodes (id, session_id, stable_id, label, file, start_line, end_line, change_status, review_status, reviewed_in_unit, is_test) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("n1", "s1", "fn:x", "x", "x.ts", 1, 2, "changed", "unreviewed", null, 0);

    expect(() => migrate(db)).not.toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);

    const cols = (db.pragma("table_info(nodes)") as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("residual_ranges");
    const row = db.prepare("SELECT residual_ranges FROM nodes WHERE id = ?").get("n1") as { residual_ranges: unknown };
    expect(row.residual_ranges).toBeNull();
    db.close();
  });
});

describe("v4 anchor column", () => {
  it("migrates to v4 and persists an anchor JSON round-trip", () => {
    const db = createMemoryDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    const cols = (db.prepare("PRAGMA table_info(comments)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("anchor");
    db.close();
  });

  it("adds review_sessions.index_warnings via the v5 migration, '[]' for existing rows", () => {
    const db = createUnmigratedMemoryDatabase();
    for (const v of [1, 2, 3, 4]) db.exec(MIGRATIONS[v]);
    db.prepare(
      "INSERT INTO review_sessions (id, branch, base_ref, status, created_at, head_sha) VALUES ('s1', 'b', 'main', 'planning', 0, '')",
    ).run();
    db.exec(MIGRATIONS[5]);
    const row = db.prepare("SELECT index_warnings FROM review_sessions WHERE id = 's1'").get() as {
      index_warnings: string;
    };
    expect(row.index_warnings).toBe("[]");
  });

  it("adds units.attached via the v6 migration, '[]' for existing rows", () => {
    const db = createUnmigratedMemoryDatabase();
    for (const v of [1, 2, 3, 4, 5]) db.exec(MIGRATIONS[v]);
    db.prepare(
      "INSERT INTO review_sessions (id, branch, base_ref, status, created_at, head_sha) VALUES ('s1', 'b', 'main', 'planning', 0, '')",
    ).run();
    db.prepare("INSERT INTO units (id, session_id, position, label) VALUES ('u1', 's1', 0, 'Unit')").run();
    db.exec(MIGRATIONS[6]);
    const row = db.prepare("SELECT attached FROM units WHERE id = 'u1'").get() as { attached: string };
    expect(row.attached).toBe("[]");
  });
});

describe("v8 nullable comments.node_id", () => {
  it("rebuilds comments preserving existing rows and allows NULL node_id after", () => {
    const db = createUnmigratedMemoryDatabase();
    db.pragma("foreign_keys = ON");
    for (const v of [1, 2, 3, 4, 5, 6, 7]) db.exec(MIGRATIONS[v]);
    db.prepare(
      "INSERT INTO review_sessions (id, branch, base_ref, status, created_at, head_sha) VALUES ('s1', 'b', 'main', 'planning', 0, '')",
    ).run();
    db.prepare(
      "INSERT INTO nodes (id, session_id, stable_id, label, file, start_line, end_line, change_status, review_status, reviewed_in_unit, is_test) VALUES ('n1', 's1', 'fn:x', 'x', 'x.ts', 1, 2, 'changed', 'unreviewed', NULL, 0)",
    ).run();
    db.prepare(
      "INSERT INTO comments (id, session_id, node_id, hunk_snippet, text, structural_context, created_at, anchor) VALUES ('c1', 's1', 'n1', 'snip', 'existing', '', 1, '{\"startLine\":1,\"startSide\":\"new\",\"endLine\":1,\"endSide\":\"new\"}')",
    ).run();
    // pre-v8 the NOT NULL constraint rejects a session-wide comment
    expect(() =>
      db
        .prepare(
          "INSERT INTO comments (id, session_id, node_id, hunk_snippet, text, structural_context, created_at) VALUES ('c2', 's1', NULL, '', 'nope', '', 2)",
        )
        .run(),
    ).toThrow();

    db.exec(MIGRATIONS[8]);

    const kept = db.prepare("SELECT * FROM comments WHERE id = 'c1'").get() as {
      node_id: string;
      text: string;
      anchor: string;
    };
    expect(kept.node_id).toBe("n1");
    expect(kept.text).toBe("existing");
    expect(kept.anchor).toContain("startLine");
    db.prepare(
      "INSERT INTO comments (id, session_id, node_id, hunk_snippet, text, structural_context, created_at) VALUES ('c2', 's1', NULL, '', 'session-wide', '', 2)",
    ).run();
    // cascade on session delete still covers node-less comments
    db.prepare("DELETE FROM review_sessions WHERE id = 's1'").run();
    expect((db.prepare("SELECT COUNT(*) AS c FROM comments").get() as { c: number }).c).toBe(0);
    db.close();
  });
});
