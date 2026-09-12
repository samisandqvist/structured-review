import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/db/connection.js";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/db/schema.js";

const temporaryRoots: string[] = [];

function temporaryDatabasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "srev-persistence-"));
  temporaryRoots.push(root);
  return join(root, "review.db");
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seedVersion7Database(path: string): void {
  const legacy = new DatabaseSync(path);
  legacy.exec("PRAGMA foreign_keys = ON");
  for (let version = 1; version <= 7; version++) {
    const migration = MIGRATIONS[version];
    if (!migration) throw new Error(`missing test fixture migration ${version}`);
    legacy.exec(migration);
    legacy.exec(`PRAGMA user_version = ${version}`);
  }
  legacy
    .prepare(
      "INSERT INTO review_sessions (id, branch, base_ref, status, created_at, head_sha, repo_fingerprint, index_warnings) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run("s1", "feature/persist", "main", "walking", 123, "abc", "fp", '["java skipped"]');
  legacy
    .prepare(
      "INSERT INTO units (id, session_id, position, label, rationale, kind, member_stable_ids, auto, attached) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run("u1", "s1", 0, "Core flow", "because", "flow", '["fn:a"]', 0, "[]");
  const insertNode = legacy.prepare(
    "INSERT INTO nodes (id, session_id, stable_id, label, file, start_line, end_line, change_status, review_status, reviewed_in_unit, is_test, residual_ranges, residual_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insertNode.run("n1", "s1", "fn:a", "a", "src/a.ts", 2, 5, "changed", "reviewed-commented", 0, 0, null, null);
  insertNode.run("n2", "s1", "fn:b", "b", "src/b.ts", 7, 9, "unchanged", "unreviewed", null, 0, null, null);
  legacy
    .prepare("INSERT INTO edges (id, session_id, source_node_id, target_node_id, edge_type) VALUES (?, ?, ?, ?, ?)")
    .run("e1", "s1", "n1", "n2", "call");
  legacy
    .prepare(
      "INSERT INTO comments (id, session_id, node_id, hunk_snippet, text, structural_context, created_at, anchor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run("c1", "s1", "n1", "+ changed", "keep this", "calls: b", 456, '{"startLine":2}');
  legacy.close();
}

describe("file-backed database recovery", () => {
  it("migrates a populated v7 database without losing sessions, units, nodes, edges, or comments", () => {
    const path = temporaryDatabasePath();
    seedVersion7Database(path);

    const migrated = createDatabase(path);
    expect(migrated.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(
      migrated.prepare("SELECT branch, index_warnings, overview FROM review_sessions WHERE id = 's1'").get(),
    ).toEqual({
      branch: "feature/persist",
      index_warnings: '["java skipped"]',
      overview: "",
    });
    expect(migrated.prepare("SELECT label, member_stable_ids FROM units WHERE id = 'u1'").get()).toEqual({
      label: "Core flow",
      member_stable_ids: '["fn:a"]',
    });
    expect(migrated.prepare("SELECT stable_id, review_status FROM nodes WHERE id = 'n1'").get()).toEqual({
      stable_id: "fn:a",
      review_status: "reviewed-commented",
    });
    expect(migrated.prepare("SELECT source_node_id, target_node_id FROM edges WHERE id = 'e1'").get()).toEqual({
      source_node_id: "n1",
      target_node_id: "n2",
    });
    expect(migrated.prepare("SELECT node_id, text, anchor FROM comments WHERE id = 'c1'").get()).toEqual({
      node_id: "n1",
      text: "keep this",
      anchor: '{"startLine":2}',
    });
    migrated
      .prepare(
        "INSERT INTO comments (id, session_id, node_id, hunk_snippet, text, structural_context, created_at) VALUES (?, ?, NULL, '', ?, '', ?)",
      )
      .run("c2", "s1", "session note", 789);
    migrated.close();

    const reopened = createDatabase(path);
    expect(reopened.prepare("SELECT text FROM comments ORDER BY created_at").all()).toEqual([
      { text: "keep this" },
      { text: "session note" },
    ]);
    reopened.close();
  });

  it("rolls back a deterministic SQL fault and persists the next committed transaction after reopen", () => {
    const path = temporaryDatabasePath();
    const db = createDatabase(path);
    const insert = db.prepare(
      "INSERT INTO review_sessions (id, branch, base_ref, status, created_at, head_sha, repo_fingerprint, index_warnings, overview) VALUES (?, ?, ?, 'planning', ?, '', '', '[]', '')",
    );

    expect(() =>
      db.transaction(() => {
        insert.run("rolled-back", "fault", "main", 1);
        insert.run("rolled-back", "duplicate", "main", 2);
      })(),
    ).toThrow("UNIQUE constraint failed: review_sessions.id");
    expect(db.prepare("SELECT COUNT(*) AS count FROM review_sessions WHERE id = 'rolled-back'").get()).toEqual({
      count: 0,
    });

    db.transaction(() => {
      insert.run("committed", "feature/reopen", "main", 3);
      db.prepare(
        "INSERT INTO units (id, session_id, position, label, rationale, kind, member_stable_ids, auto, attached) VALUES (?, ?, 0, ?, '', 'orphans', '[]', 0, '[]')",
      ).run("u-committed", "committed", "Persisted unit");
    })();
    db.close();

    const reopened = createDatabase(path);
    expect(reopened.prepare("SELECT branch FROM review_sessions WHERE id = 'committed'").get()).toEqual({
      branch: "feature/reopen",
    });
    expect(reopened.prepare("SELECT label FROM units WHERE session_id = 'committed'").get()).toEqual({
      label: "Persisted unit",
    });
    expect(reopened.prepare("SELECT COUNT(*) AS count FROM review_sessions WHERE id = 'rolled-back'").get()).toEqual({
      count: 0,
    });
    reopened.close();
  });
});
