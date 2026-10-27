// The base side of a review map: a shared clone of the reviewed repository at
// the session's pinned base commit, indexed by its own graph provider. The
// clone borrows the repository's objects (`--shared`) and writes nothing into
// it; it lives in the hub's per-user base directory as a cache that is
// rebuilt when it is missing and removed with its session.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitError } from "../diff.js";
import type { GraphProvider } from "../graph/provider.js";
import type { ReferenceIndex } from "../graph/references.js";

export interface BaseIndex {
  root: string;
  index: ReferenceIndex;
}

const QUIET = { encoding: "utf8" as const, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };

/** The git object type `sha` names in `root` (`commit`, `tree`, …), or null when it is missing. */
export function objectType(sha: string, root: string): string | null {
  try {
    return execFileSync("git", ["cat-file", "-t", sha], { cwd: root, ...QUIET }).trim();
  } catch {
    return null;
  }
}

/** The base copy only feeds the indexer: the user's hooks stay unrun and
 *  LFS content stays on the server (pointer files index as text). */
const UNHOOKED = ["-c", "core.hooksPath=/dev/null"];
const checkoutOptions = () => ({ ...QUIET, env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" } });

/** Written after a checkout completes; a clone without it was interrupted. */
const READY = join(".git", "srev-ready");

function readyAt(dir: string): string | null {
  try {
    return readFileSync(join(dir, READY), "utf8").trim();
  } catch {
    return null;
  }
}

function originOf(dir: string): string | null {
  try {
    const config = join(dir, ".git", "config");
    return execFileSync("git", ["config", "--file", config, "--get", "remote.origin.url"], QUIET).trim();
  } catch {
    return null;
  }
}

function checkout(dir: string, repoRoot: string, sha: string): void {
  if (readyAt(dir) === sha) return;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    execFileSync("git", [...UNHOOKED, "clone", "--shared", "--no-checkout", "-q", repoRoot, dir], checkoutOptions());
    execFileSync("git", [...UNHOOKED, "checkout", "-q", "--detach", sha], { cwd: dir, ...checkoutOptions() });
    writeFileSync(join(dir, READY), sha);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new GitError("base-checkout", `cannot check out base commit ${sha}: ${(e as Error).message}`);
  }
}

export class BaseIndexes {
  private indexes = new Map<string, Promise<BaseIndex>>();

  constructor(
    private baseDir: string,
    private providerFor: (root: string) => GraphProvider,
  ) {}

  /** The session's base checkout and its reference index, built on first use. */
  get(sessionId: string, repoRoot: string, sha: string): Promise<BaseIndex> {
    const dir = join(this.baseDir, sessionId);
    let pending = this.indexes.get(sessionId);
    if (!pending || !existsSync(dir)) {
      pending = this.build(dir, repoRoot, sha);
      this.indexes.set(sessionId, pending);
      pending.catch(() => this.indexes.delete(sessionId));
    }
    return pending;
  }

  drop(sessionId: string): void {
    this.indexes.delete(sessionId);
    rmSync(join(this.baseDir, sessionId), { recursive: true, force: true });
  }

  /** Removes the checkouts of `repoRoot` whose sessions are gone. Other
   *  repositories' hubs share the directory, so a checkout cloned from
   *  elsewhere, or one whose origin cannot be read, stays. */
  sweep(repoRoot: string, sessions: Set<string>): void {
    if (!existsSync(this.baseDir)) return;
    for (const entry of readdirSync(this.baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || sessions.has(entry.name)) continue;
      const dir = join(this.baseDir, entry.name);
      if (originOf(dir) === repoRoot) this.drop(entry.name);
    }
  }

  private async build(dir: string, repoRoot: string, sha: string): Promise<BaseIndex> {
    checkout(dir, repoRoot, sha);
    const provider = this.providerFor(dir);
    if (!provider.getReferenceIndex) throw new Error("the graph provider has no reference index");
    return { root: dir, index: await provider.getReferenceIndex() };
  }
}
