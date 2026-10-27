// The base side of a review map: a shared clone of the reviewed repository at
// the session's pinned base commit, indexed by its own graph provider. The
// clone borrows the repository's objects (`--shared`) and writes nothing into
// it; it lives in the hub's base directory as a cache that is rebuilt when it
// is missing and removed with its session.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { GitError } from "../diff.js";
import type { GraphProvider } from "../graph/provider.js";
import type { ReferenceIndex } from "../graph/references.js";

export interface BaseIndex {
  root: string;
  index: ReferenceIndex;
}

const QUIET = { encoding: "utf8" as const, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };

/** True when `sha` names a commit in `root` (the empty tree of a whole-repository session does not). */
export function isCommit(sha: string, root: string): boolean {
  try {
    return execFileSync("git", ["cat-file", "-t", sha], { cwd: root, ...QUIET }).trim() === "commit";
  } catch {
    return false;
  }
}

function headOf(dir: string): string | null {
  if (!existsSync(join(dir, ".git"))) return null;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, ...QUIET }).trim();
  } catch {
    return null;
  }
}

function checkout(dir: string, repoRoot: string, sha: string): void {
  if (headOf(dir) === sha) return;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    execFileSync("git", ["clone", "--shared", "--no-checkout", "-q", repoRoot, dir], QUIET);
    execFileSync("git", ["checkout", "-q", "--detach", sha], { cwd: dir, ...QUIET });
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

  private async build(dir: string, repoRoot: string, sha: string): Promise<BaseIndex> {
    checkout(dir, repoRoot, sha);
    const provider = this.providerFor(dir);
    if (!provider.getReferenceIndex) throw new Error("the graph provider has no reference index");
    return { root: dir, index: await provider.getReferenceIndex() };
  }
}
