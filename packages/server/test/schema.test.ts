import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { createMemoryDatabase, migrate } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";

describe("schema", () => {
  it("creates all tables", () => {
    const db = createMemoryDatabase();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
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
      db.prepare(
        "INSERT INTO units (id, session_id, position, label, rationale) VALUES (?, ?, ?, ?, ?)"
      ).run("u1", "nonexistent", 0, "test", "test")
    ).toThrow();
    db.close();
  });

  it("stamps a fresh database with SCHEMA_VERSION", () => {
    const db = createMemoryDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("migrates a version-0 database with existing tables to current", () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE IF NOT EXISTS review_sessions (id TEXT PRIMARY KEY, branch TEXT NOT NULL, base_ref TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'planning', created_at INTEGER NOT NULL, head_sha TEXT NOT NULL DEFAULT '')"
    );
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    expect(() => migrate(db)).not.toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("rejects a database newer than the application", () => {
    const db = new Database(":memory:");
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    expect(() => migrate(db)).toThrow(/newer/i);
    db.close();
  });
});
