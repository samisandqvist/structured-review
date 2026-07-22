// packages/skill/test/gc.test.ts — file-level pieces of `crw gc`: the
// dead-repo sweep over CRW_DATA_DIR state. Hub-stopping paths need a live
// server and are covered by the server's shutdown route tests.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gcSweep } from "../src/gc.js";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "crw-gc-"));
  mkdirSync(join(dataDir, "db"), { recursive: true });
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

function fakeState(key: string, repoRoot?: string): void {
  writeFileSync(join(dataDir, "db", `${key}.db`), "sqlite");
  writeFileSync(join(dataDir, "db", `${key}.db-wal`), "wal");
  mkdirSync(join(dataDir, "logs", key), { recursive: true });
  writeFileSync(join(dataDir, "logs", key, "server.log"), "log");
  if (repoRoot) writeFileSync(join(dataDir, "logs", key, "repo-root"), `${repoRoot}\n`);
}

describe("gcSweep", () => {
  it("removes DB (incl. WAL siblings) and logs for repos that no longer exist", () => {
    fakeState("dead-abc123", join(dataDir, "no-such-repo"));
    const result = gcSweep(dataDir);
    expect(result.swept).toHaveLength(1);
    expect(result.swept[0].key).toBe("dead-abc123");
    expect(result.swept[0].removed).toContain(join(dataDir, "db", "dead-abc123.db"));
    expect(result.swept[0].removed).toContain(join(dataDir, "db", "dead-abc123.db-wal"));
    expect(existsSync(join(dataDir, "db", "dead-abc123.db"))).toBe(false);
    expect(existsSync(join(dataDir, "logs", "dead-abc123"))).toBe(false);
  });

  it("leaves state alone when the repo still exists", () => {
    const repo = mkdtempSync(join(tmpdir(), "crw-gc-repo-"));
    try {
      fakeState("alive-def456", repo);
      const result = gcSweep(dataDir);
      expect(result.swept).toEqual([]);
      expect(result.skipped[0].reason).toContain(repo);
      expect(existsSync(join(dataDir, "db", "alive-def456.db"))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("skips (never guesses at) state without a repo-root sidecar", () => {
    fakeState("legacy-789");
    const result = gcSweep(dataDir);
    expect(result.swept).toEqual([]);
    expect(result.skipped[0].key).toBe("legacy-789");
    expect(result.skipped[0].reason).toMatch(/sidecar/);
    expect(existsSync(join(dataDir, "db", "legacy-789.db"))).toBe(true);
  });

  it("handles a data dir with no db directory", () => {
    const empty = mkdtempSync(join(tmpdir(), "crw-gc-empty-"));
    try {
      expect(gcSweep(empty)).toEqual({ swept: [], skipped: [] });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
