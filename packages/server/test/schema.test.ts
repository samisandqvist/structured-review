import { describe, it, expect } from "vitest";
import { createMemoryDatabase } from "../src/db/connection.js";

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
});
