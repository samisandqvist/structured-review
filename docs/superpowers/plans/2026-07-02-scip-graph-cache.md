# SCIP Graph Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ScipGraphProvider` indexes the repo once per repo state instead of once per request.

**Architecture:** Split `buildGraph()` into a protected `indexAndBuild()` (the current body) and a caching wrapper keyed on `git rev-parse HEAD` + `git status --porcelain`. The cache stores the in-flight promise so concurrent callers share one index run; rejection clears the entry. Spec: `docs/superpowers/specs/2026-07-02-scip-graph-cache-design.md`.

**Tech Stack:** TypeScript (strict), vitest, better-sqlite3 untouched; only `packages/server/src/graph/scip.ts` changes.

## Global Constraints

- `SCIP_NO_CACHE=1` env bypasses the cache entirely.
- No `GraphProvider` interface change; CRG/stub providers untouched.
- Single-entry cache (latest repo state only).
- `repoStateKey()` failure = cache miss, never a throw.

---

### Task 1: Cache with in-flight promise + protected seams

**Files:**
- Modify: `packages/server/src/graph/scip.ts` (rename `buildGraph` body → `indexAndBuild`, add cache + `repoStateKey`)
- Test: `packages/server/test/scip-cache.test.ts` (new)

**Interfaces:**
- Consumes: existing `ScipGraphProvider`, `BuiltGraph` (must become exported).
- Produces: `protected repoStateKey(): string`, `protected indexAndBuild(): Promise<BuiltGraph>`, caching `private buildGraph()`. Tests subclass and override both protected methods.

- [ ] **Step 1: Export `BuiltGraph` and write the failing tests**

In `scip.ts` change `interface BuiltGraph` to `export interface BuiltGraph`.

Create `packages/server/test/scip-cache.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @crw/server exec vitest run test/scip-cache.test.ts`
Expected: FAIL — `repoStateKey`/`indexAndBuild` do not exist / are not overridable, builds counted per call.

- [ ] **Step 3: Implement the cache in `scip.ts`**

Rename the existing `private async buildGraph()` to `protected async indexAndBuild()` (body unchanged). Add:

```ts
export class ScipGraphProvider implements GraphProvider {
  // ...existing fields...
  private cache?: { key: string; graph: Promise<BuiltGraph> };

  /** Repo-state fingerprint: HEAD + working-tree status. Any failure = unique key (cache miss). */
  protected repoStateKey(): string {
    try {
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: this.repoRoot, encoding: "utf8" });
      const status = execFileSync("git", ["status", "--porcelain"], { cwd: this.repoRoot, encoding: "utf8" });
      return `${head.trim()}\n${status}`;
    } catch {
      return `no-git:${Math.random()}`;
    }
  }

  private buildGraph(): Promise<BuiltGraph> {
    if (process.env.SCIP_NO_CACHE === "1") return this.indexAndBuild();
    const key = this.repoStateKey();
    if (this.cache?.key === key) return this.cache.graph;
    const entry = { key, graph: this.indexAndBuild() };
    this.cache = entry;
    entry.graph.catch(() => {
      if (this.cache === entry) this.cache = undefined;
    });
    return entry.graph;
  }
}
```

Note: the `.catch` side-channel must not swallow the rejection for callers — it attaches a handler on the same promise object callers receive, which is fine (callers still get the rejection); it only prevents an unhandled-rejection warning when no caller is waiting.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @crw/server exec vitest run test/scip-cache.test.ts`
Expected: PASS (5 tests). Then run the full suite: `pnpm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/graph/scip.ts packages/server/test/scip-cache.test.ts
git commit -m "feat(server): per-repo-state cache for SCIP graph builds"
```

### Task 2: Real `repoStateKey` behavior against a fixture git repo

**Files:**
- Test: `packages/server/test/scip-cache.test.ts` (extend)

**Interfaces:**
- Consumes: `ScipGraphProvider` with `repoRoot` option; protected `repoStateKey` (expose to the test via a subclass that publicizes it).

- [ ] **Step 1: Write the failing test**

Append to `scip-cache.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

class KeyProbe extends ScipGraphProvider {
  publicKey(): string { return this.repoStateKey(); }
}

describe("repoStateKey", () => {
  it("is stable for an unchanged repo and changes on edits/commits", () => {
    const dir = mkdtempSync(join(tmpdir(), "crw-key-"));
    try {
      const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
      git("init");
      git("config", "user.email", "t@t"); git("config", "user.name", "t");
      writeFileSync(join(dir, "a.txt"), "one\n");
      git("add", "."); git("commit", "-m", "init");

      const p = new KeyProbe({ repoRoot: dir });
      const k1 = p.publicKey();
      expect(p.publicKey()).toBe(k1);           // stable
      writeFileSync(join(dir, "a.txt"), "two\n");
      expect(p.publicKey()).not.toBe(k1);       // dirty tree changes key
      git("add", "."); git("commit", "-m", "edit");
      expect(p.publicKey()).not.toBe(k1);       // new HEAD changes key
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
```

Note: `git init` in a temp dir under `/tmp` is outside any parent repo, so `git status` sees only the fixture. `git rev-parse HEAD` inside a non-git dir throws — but beware: git walks up parent directories; `/tmp` is not a repo, so the no-git test is valid.

- [ ] **Step 2: Run tests**

Run: `pnpm --filter @crw/server exec vitest run test/scip-cache.test.ts`
Expected: PASS immediately if Task 1's implementation is correct (this task is behavioral verification of the real key; if it fails, fix `repoStateKey`).

- [ ] **Step 3: Commit**

```bash
git add packages/server/test/scip-cache.test.ts
git commit -m "test(server): repoStateKey fixture-repo behavior"
```
