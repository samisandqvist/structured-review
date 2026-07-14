import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScipGraphProvider, type BuiltGraph } from "../src/graph/scip.js";

const EMPTY: BuiltGraph = { nodes: new Map(), callAdj: new Map(), callRev: new Map() };

class FakeProvider extends ScipGraphProvider {
  builds = 0;
  key = "k1";
  pending: Array<(g: BuiltGraph) => void> = [];
  deferred = false;
  protected override repoStateKey(): string { return this.key; }
  protected override indexAndBuild(): Promise<BuiltGraph> {
    this.builds++;
    if (!this.deferred) return Promise.resolve(EMPTY);
    return new Promise((resolve) => this.pending.push(resolve));
  }
}

afterEach(() => { delete process.env.SCIP_NO_CACHE; });

describe("ScipGraphProvider cache", () => {
  it("indexes once for repeated calls with the same key", async () => {
    const p = new FakeProvider({ repoRoot: "/tmp" });
    await p.getNeighbors("x");
    await p.getNeighbors("y");
    await p.getFlows();
    expect(p.builds).toBe(1);
  });

  it("re-indexes when the key changes", async () => {
    const p = new FakeProvider({ repoRoot: "/tmp" });
    await p.getNeighbors("x");
    p.key = "k2";
    await p.getNeighbors("x");
    expect(p.builds).toBe(2);
  });

  it("concurrent calls during a miss share one index run", async () => {
    const p = new FakeProvider({ repoRoot: "/tmp" });
    p.deferred = true;
    const a = p.getNeighbors("x");
    const b = p.getFlows();
    p.pending[0](EMPTY);
    await Promise.all([a, b]);
    expect(p.builds).toBe(1);
  });

  it("SCIP_NO_CACHE=1 bypasses the cache", async () => {
    process.env.SCIP_NO_CACHE = "1";
    const p = new FakeProvider({ repoRoot: "/tmp" });
    await p.getNeighbors("x");
    await p.getNeighbors("x");
    expect(p.builds).toBe(2);
  });

  it("a failed build clears the cache so the next call retries", async () => {
    class FailingOnce extends FakeProvider {
      failFirst = true;
      protected override indexAndBuild(): Promise<BuiltGraph> {
        this.builds++;
        if (this.failFirst) { this.failFirst = false; return Promise.reject(new Error("indexer died")); }
        return Promise.resolve(EMPTY);
      }
    }
    const p = new FailingOnce({ repoRoot: "/tmp" });
    await expect(p.getNeighbors("x")).rejects.toThrow("indexer died");
    await p.getNeighbors("x"); // retries, succeeds
    expect(p.builds).toBe(2);
  });
});

class KeyProbe extends ScipGraphProvider {
  publicKey(): string { return this.repoStateKey(); }
}

describe("repoStateKey", () => {
  it("is stable for an unchanged repo and changes on edits/commits", () => {
    const dir = mkdtempSync(join(tmpdir(), "crw-key-"));
    try {
      const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
      git("init");
      git("config", "user.email", "t@t");
      git("config", "user.name", "t");
      writeFileSync(join(dir, "a.txt"), "one\n");
      git("add", ".");
      git("commit", "-m", "init");

      const p = new KeyProbe({ repoRoot: dir });
      const k1 = p.publicKey();
      expect(p.publicKey()).toBe(k1); // stable
      writeFileSync(join(dir, "a.txt"), "two\n");
      const k2 = p.publicKey();
      expect(k2).not.toBe(k1); // dirty tree changes key
      git("add", ".");
      git("commit", "-m", "edit");
      expect(p.publicKey()).not.toBe(k2); // new HEAD changes key
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-indexes after editing an already-dirty file (content-sensitive key)", () => {
    const dir = mkdtempSync(join(tmpdir(), "crw-key-dirty-"));
    try {
      const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
      git("init");
      git("config", "user.email", "t@t");
      git("config", "user.name", "t");
      writeFileSync(join(dir, "a.txt"), "one\n");
      git("add", ".");
      git("commit", "-m", "init");

      const p = new KeyProbe({ repoRoot: dir });
      writeFileSync(join(dir, "a.txt"), "dirty1\n");
      const k1 = p.publicKey();
      writeFileSync(join(dir, "a.txt"), "dirty2\n"); // porcelain unchanged, content differs
      expect(p.publicKey()).not.toBe(k1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a unique key when git is unavailable (cache miss, no throw)", () => {
    const dir = mkdtempSync(join(tmpdir(), "crw-nogit-"));
    try {
      const p = new KeyProbe({ repoRoot: dir });
      expect(p.publicKey()).not.toBe(p.publicKey());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
