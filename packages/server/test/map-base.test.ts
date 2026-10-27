// The base checkout of a review session: a shared clone at the pinned commit
// in the hub's base directory, indexed by a second provider, leaving the
// reviewed repository untouched.
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseIndexes, objectType } from "../src/map/base.js";
import { EMPTY_TREE_SHA, GitError } from "../src/diff.js";
import type { GraphProvider } from "../src/graph/provider.js";
import type { ReferenceIndex } from "../src/graph/references.js";

const repo = mkdtempSync(join(tmpdir(), "srev-base-repo-"));
const baseDir = mkdtempSync(join(tmpdir(), "srev-base-dir-"));
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(baseDir, { recursive: true, force: true });
});
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();

mkdirSync(join(repo, "src"));
git("init", "-q", "-b", "main");
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
writeFileSync(join(repo, "src/a.ts"), "export const a = 'base';\n");
git("add", "-A");
git("commit", "-qm", "base");
const baseSha = git("rev-parse", "HEAD");
writeFileSync(join(repo, "src/a.ts"), "export const a = 'head';\n");
git("commit", "-qam", "head");

const INDEX: ReferenceIndex = {
  files: ["src/a.ts"],
  definitions: new Map(),
  references: [],
  implementations: new Map(),
  barrels: [],
  gaps: [],
};

function stubProviders() {
  const roots: string[] = [];
  const providerFor = (root: string): GraphProvider =>
    ({
      getReferenceIndex: () => {
        roots.push(root);
        return Promise.resolve(INDEX);
      },
    }) as unknown as GraphProvider;
  return { roots, providerFor };
}

describe("BaseIndexes", () => {
  it("checks out the pinned commit and indexes it", async () => {
    const { roots, providerFor } = stubProviders();
    const gitFiles = readdirSync(join(repo, ".git")).sort();
    const bases = new BaseIndexes(baseDir, providerFor);
    const base = await bases.get("ses_a", repo, baseSha);
    expect(base.index).toBe(INDEX);
    expect(readFileSync(join(base.root, "src/a.ts"), "utf8")).toContain("base");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: base.root, encoding: "utf8" }).trim()).toBe(baseSha);
    expect(git("worktree", "list").split("\n")).toHaveLength(1);
    expect(readdirSync(join(repo, ".git")).sort()).toEqual(gitFiles);

    await bases.get("ses_a", repo, baseSha);
    expect(roots).toHaveLength(1);
  });

  it("recreates a checkout that disappeared and reuses one that is in place", async () => {
    const { roots, providerFor } = stubProviders();
    const bases = new BaseIndexes(baseDir, providerFor);
    const { root } = await bases.get("ses_b", repo, baseSha);
    rmSync(root, { recursive: true, force: true });
    await bases.get("ses_b", repo, baseSha);
    expect(existsSync(join(root, "src/a.ts"))).toBe(true);

    const restarted = new BaseIndexes(baseDir, providerFor);
    await restarted.get("ses_b", repo, baseSha);
    expect(roots).toEqual([root, root, root]);
  });

  it("drops the checkout with its session", async () => {
    const bases = new BaseIndexes(baseDir, stubProviders().providerFor);
    const { root } = await bases.get("ses_c", repo, baseSha);
    bases.drop("ses_c");
    expect(existsSync(root)).toBe(false);
  });

  it("reports a commit that cannot be checked out and retries later", async () => {
    const bases = new BaseIndexes(baseDir, stubProviders().providerFor);
    await expect(bases.get("ses_d", repo, "0".repeat(40))).rejects.toBeInstanceOf(GitError);
    await expect(bases.get("ses_d", repo, baseSha)).resolves.toMatchObject({ index: INDEX });
  });

  it("refuses a provider without a reference index", async () => {
    const bases = new BaseIndexes(baseDir, () => ({}) as GraphProvider);
    await expect(bases.get("ses_e", repo, baseSha)).rejects.toThrow(/reference index/);
  });
});

describe("BaseIndexes after an interrupted checkout", () => {
  it("does not reuse a clone whose checkout never finished", async () => {
    const headSha = git("rev-parse", "HEAD");
    const dir = join(baseDir, "ses_crash");
    execFileSync("git", ["clone", "--shared", "--no-checkout", "-q", repo, dir]);
    const bases = new BaseIndexes(baseDir, stubProviders().providerFor);
    const { root } = await bases.get("ses_crash", repo, headSha);
    expect(readFileSync(join(root, "src/a.ts"), "utf8")).toContain("head");
  });
});

describe("objectType", () => {
  it("tells commits from the empty tree and unknown shas", () => {
    expect(objectType(baseSha, repo)).toBe("commit");
    expect(objectType(EMPTY_TREE_SHA, repo)).toBe("tree");
    expect(objectType("0".repeat(40), repo)).toBeNull();
  });
});

describe("BaseIndexes and the user's git setup", () => {
  it("runs no git hooks and downloads no LFS content while checking out", async () => {
    const home = mkdtempSync(join(tmpdir(), "srev-base-home-"));
    const marker = join(home, "ran");
    const hooks = join(home, "hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\necho hook >> "${marker}"\n`, { mode: 0o755 });
    const smudge = join(home, "smudge");
    writeFileSync(smudge, `#!/bin/sh\n[ -z "$GIT_LFS_SKIP_SMUDGE" ] && echo smudge >> "${marker}"\ncat\n`, {
      mode: 0o755,
    });
    const config = join(home, "gitconfig");
    writeFileSync(config, `[core]\n\thooksPath = ${hooks}\n[filter "lfs"]\n\tclean = cat\n\tsmudge = ${smudge}\n`);
    const gitEnv = { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
    const lfsRepo = join(home, "repo");
    mkdirSync(lfsRepo);
    const run = (...a: string[]) =>
      execFileSync("git", a, { cwd: lfsRepo, encoding: "utf8", env: { ...process.env, ...gitEnv } }).trim();
    run("init", "-q", "-b", "main");
    run("config", "user.email", "t@example.com");
    run("config", "user.name", "t");
    writeFileSync(join(lfsRepo, ".gitattributes"), "*.bin filter=lfs\n");
    writeFileSync(join(lfsRepo, "blob.bin"), "data\n");
    run("add", "-A");
    run("commit", "-qm", "lfs");
    const sha = run("rev-parse", "HEAD");
    const saved = { ...process.env };
    Object.assign(process.env, gitEnv);
    try {
      const bases = new BaseIndexes(join(home, "bases"), stubProviders().providerFor);
      const { root } = await bases.get("ses_hooks", lfsRepo, sha);
      expect(readFileSync(join(root, "blob.bin"), "utf8")).toBe("data\n");
      expect(existsSync(marker)).toBe(false);
    } finally {
      for (const name of Object.keys(gitEnv)) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("BaseIndexes.sweep", () => {
  it("removes this repository's checkouts of sessions that no longer exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "srev-base-sweep-"));
    const other = mkdtempSync(join(tmpdir(), "srev-base-other-"));
    execFileSync("git", ["init", "-q", other]);
    try {
      const bases = new BaseIndexes(dir, stubProviders().providerFor);
      const live = await bases.get("ses_live", repo, baseSha);
      const gone = await bases.get("ses_gone", repo, baseSha);
      execFileSync("git", ["clone", "-q", other, join(dir, "ses_other")], { stdio: "ignore" });
      mkdirSync(join(dir, "notes"));
      new BaseIndexes(dir, stubProviders().providerFor).sweep(repo, new Set(["ses_live"]));
      expect(existsSync(live.root)).toBe(true);
      expect(existsSync(gone.root)).toBe(false);
      expect(existsSync(join(dir, "ses_other"))).toBe(true);
      expect(existsSync(join(dir, "notes"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("does nothing when the base directory does not exist yet", () => {
    const bases = new BaseIndexes(join(tmpdir(), "srev-base-missing-dir"), stubProviders().providerFor);
    expect(() => bases.sweep(repo, new Set())).not.toThrow();
  });
});
