import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScipGraphProvider, type BuiltGraph, type ScipDocument } from "../src/graph/scip.js";
import { type IndexerJob } from "../src/graph/roots.js";

const EMPTY: BuiltGraph = { nodes: new Map(), callAdj: new Map(), callRev: new Map() };

class FakeProvider extends ScipGraphProvider {
  builds = 0;
  key = "k1";
  pending: Array<(g: BuiltGraph) => void> = [];
  deferred = false;
  protected override repoStateKey(): string {
    return this.key;
  }
  protected override indexAndBuild(): Promise<BuiltGraph> {
    this.builds++;
    if (!this.deferred) return Promise.resolve(EMPTY);
    return new Promise((resolve) => this.pending.push(resolve));
  }
}

afterEach(() => {
  delete process.env.SCIP_NO_CACHE;
});

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
        if (this.failFirst) {
          this.failFirst = false;
          return Promise.reject(new Error("indexer died"));
        }
        return Promise.resolve(EMPTY);
      }
    }
    const p = new FailingOnce({ repoRoot: "/tmp" });
    await expect(p.getNeighbors("x")).rejects.toThrow("indexer died");
    await p.getNeighbors("x"); // retries, succeeds
    expect(p.builds).toBe(2);
  });

  it("exposes the build's warnings via getIndexWarnings", async () => {
    class WarnProvider extends FakeProvider {
      protected override indexAndBuild(): Promise<BuiltGraph> {
        this.builds++;
        return Promise.resolve({ ...EMPTY, warnings: ["Java indexing skipped for 1 root(s)"] });
      }
    }
    const p = new WarnProvider({ repoRoot: "/tmp" });
    expect(await p.getIndexWarnings()).toEqual(["Java indexing skipped for 1 root(s)"]);
    await p.getNeighbors("x");
    expect(p.builds).toBe(1); // warnings ride the same cached build
  });
});

describe("per-job cache", () => {
  class MultiFake extends ScipGraphProvider {
    ran: string[] = [];
    state: Record<string, string> = { ts: "a", py: "a" };
    failPy = false;
    protected override discoverJobs(): IndexerJob[] {
      return [
        { language: "ts", root: "", hasSources: true },
        { language: "py", root: "svc", hasSources: true },
      ];
    }
    // Whole-repo key = both subtree keys, so any edit invalidates the outer
    // cache (like the real repoFingerprint) while job caches stay per-root.
    protected override repoStateKey(): string {
      return JSON.stringify(this.state);
    }
    protected override jobStateKey(job: IndexerJob): string {
      return this.state[job.language];
    }
    protected override runIndexer(job: IndexerJob): Promise<ScipDocument[]> {
      this.ran.push(`${job.language}:${job.root}`);
      if (this.failPy && job.language === "py") return Promise.reject(new Error("py indexer died"));
      return Promise.resolve([]);
    }
  }

  it("first build runs every job", async () => {
    const p = new MultiFake({ repoRoot: "/tmp" });
    await p.getNeighbors("x");
    expect(p.ran).toEqual(["ts:", "py:svc"]);
  });

  it("editing one language's subtree re-runs only that job", async () => {
    const p = new MultiFake({ repoRoot: "/tmp" });
    await p.getNeighbors("x");
    p.state = { ...p.state, py: "b" };
    await p.getNeighbors("x");
    expect(p.ran).toEqual(["ts:", "py:svc", "py:svc"]);
  });

  it("a failed job is dropped from the job cache so the next build retries it", async () => {
    const p = new MultiFake({ repoRoot: "/tmp" });
    p.failPy = true;
    await expect(p.getNeighbors("x")).rejects.toThrow("py indexer died");
    p.failPy = false;
    p.state = { ...p.state }; // same keys: ts job cache must survive the failure
    await p.getNeighbors("x");
    expect(p.ran).toEqual(["ts:", "py:svc", "py:svc"]);
  });

  it("SCIP_NO_CACHE=1 bypasses the job cache too", async () => {
    process.env.SCIP_NO_CACHE = "1";
    const p = new MultiFake({ repoRoot: "/tmp" });
    await p.getNeighbors("x");
    await p.getNeighbors("x");
    expect(p.ran).toEqual(["ts:", "py:svc", "ts:", "py:svc"]);
  });
});

describe("discoverJobs filtering", () => {
  class JobsProbe extends ScipGraphProvider {
    jobs: IndexerJob[] = [];
    publicJobs(): IndexerJob[] {
      return this.discoverJobs();
    }
  }
  afterEach(() => {
    delete process.env.SCIP_LANGS;
  });

  it("SCIP_LANGS filters enabled languages", () => {
    process.env.SCIP_LANGS = "py";
    // this repo has a ts root and no py root -> filtered to nothing -> but the
    // fallback only fires when discovery found NO jobs at all, not when the
    // filter removed them.
    const p = new JobsProbe();
    expect(p.publicJobs()).toEqual([]);
  });

  it("defaults to ts,py — java roots are excluded until Phase 4", () => {
    const p = new JobsProbe();
    expect(p.publicJobs().every((j) => j.language === "ts" || j.language === "py")).toBe(true);
    expect(p.publicJobs().length).toBeGreaterThan(0); // this repo's own ts root
  });

  it("no marker files anywhere: falls back to a single ts root-repo job", () => {
    const dir = mkdtempSync(join(tmpdir(), "srev-no-markers-"));
    try {
      writeFileSync(join(dir, "a.ts"), "export const x = 1;\n");
      const p = new JobsProbe({ repoRoot: dir });
      expect(p.publicJobs()).toEqual([{ language: "ts", root: "", hasSources: true }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no marker files, and ts not enabled: the fallback does not fire", () => {
    const dir = mkdtempSync(join(tmpdir(), "srev-no-markers-"));
    try {
      writeFileSync(join(dir, "a.ts"), "export const x = 1;\n");
      process.env.SCIP_LANGS = "py";
      const p = new JobsProbe({ repoRoot: dir });
      expect(p.publicJobs()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("getFlows entry selection", () => {
  const raw = (label: string, file: string, isTest = false) => ({ label, file, startLine: 1, endLine: 10, isTest });
  // test -> entry -> mid -> leaf: entry's only caller is a test, mid's is production.
  const FLOW_GRAPH: BuiltGraph = {
    nodes: new Map([
      ["entry", raw("entry", "src/entry.ts")],
      ["mid", raw("mid", "src/mid.ts")],
      ["leaf", raw("leaf", "src/leaf.ts")],
      ["test", raw("testEntry", "src/entry.test.ts", true)],
    ]),
    callAdj: new Map([
      ["test", ["entry"]],
      ["entry", ["mid"]],
      ["mid", ["leaf"]],
    ]),
    callRev: new Map([
      ["entry", ["test"]],
      ["mid", ["entry"]],
      ["leaf", ["mid"]],
    ]),
  };
  class GraphStub extends ScipGraphProvider {
    protected override repoStateKey(): string {
      return "k";
    }
    protected override indexAndBuild(): Promise<BuiltGraph> {
      return Promise.resolve(FLOW_GRAPH);
    }
  }

  it("a production function whose only caller is a test still heads a flow", async () => {
    const flows = await new GraphStub({ repoRoot: "/tmp" }).getFlows();
    expect(flows).toHaveLength(1);
    expect(flows[0].steps.map((s) => s.stableId)).toEqual(["entry", "mid", "leaf"]);
  });

  it("a production function called by another production function does not", async () => {
    const flows = await new GraphStub({ repoRoot: "/tmp" }).getFlows();
    expect(flows.some((f) => f.steps[0]?.stableId === "mid")).toBe(false);
  });
});

class KeyProbe extends ScipGraphProvider {
  publicKey(): string {
    return this.repoStateKey();
  }
}

describe("repoStateKey", () => {
  it("is stable for an unchanged repo and changes on edits/commits", () => {
    const dir = mkdtempSync(join(tmpdir(), "srev-key-"));
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
    const dir = mkdtempSync(join(tmpdir(), "srev-key-dirty-"));
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
    const dir = mkdtempSync(join(tmpdir(), "srev-nogit-"));
    try {
      const p = new KeyProbe({ repoRoot: dir });
      expect(p.publicKey()).not.toBe(p.publicKey());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
