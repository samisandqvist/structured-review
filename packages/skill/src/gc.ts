// packages/skill/src/gc.ts — sanctioned state cleanup for `crw gc`.
// Removes per-repo hub state (SQLite DB + WAL/SHM siblings, log dir), stopping
// the hub first so files are never deleted under a live WAL. File-level by
// design: gc exists precisely for when the CLI/HTTP surface can't help
// (dead repos, stale state) — everything else still goes through the API.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { probeHealth, resolveGitRoot, statePaths } from "./serve.js";
import { shutdownHub } from "./api.js";

export interface GcRepoResult {
  repoRoot: string;
  hubStopped: boolean;
  removed: string[];
}

export interface GcSweepResult {
  swept: { key: string; repoRoot: string; removed: string[] }[];
  skipped: { key: string; reason: string }[];
}

/** rm the state files that exist; report the ones actually removed. */
function removePaths(paths: string[]): string[] {
  const removed: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    rmSync(p, { recursive: true, force: true });
    removed.push(p);
  }
  return removed;
}

function repoStateFiles(repoRoot: string): string[] {
  const { dbPath, logDir } = statePaths(repoRoot);
  // Without CRW_DATA_DIR the DB is review.db in the repo (server default).
  const db = dbPath ?? join(repoRoot, "review.db");
  return [db, `${db}-wal`, `${db}-shm`, logDir];
}

/** Stop the hub at baseUrl if it serves repoRoot. Prefers the shutdown
 *  endpoint; falls back to SIGTERM via the pid from /health (older hubs).
 *  Resolves once the port stops answering, so callers can delete DB files. */
export async function stopHubIfServing(baseUrl: string, repoRoot: string): Promise<boolean> {
  const health = await probeHealth(baseUrl);
  if (!health?.ok || health.repoRoot !== repoRoot) return false;
  try {
    await shutdownHub(baseUrl);
  } catch {
    if (!health.pid) throw new Error(`hub at ${baseUrl} has no shutdown endpoint and /health reported no pid — stop it manually`);
    process.kill(health.pid, "SIGTERM");
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await probeHealth(baseUrl)) === null) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`hub at ${baseUrl} did not stop within 5s — its DB was left in place`);
}

/** `crw gc --repo <path>`: stop the repo's hub (if on baseUrl) and remove its state. */
export async function gcRepo(repoPath: string, baseUrl: string): Promise<GcRepoResult> {
  const repoRoot = resolveGitRoot(repoPath);
  const hubStopped = await stopHubIfServing(baseUrl, repoRoot);
  return { repoRoot, hubStopped, removed: removePaths(repoStateFiles(repoRoot)) };
}

/** `crw gc --all`: sweep CRW_DATA_DIR state whose repo no longer exists.
 *  Keys without a repo-root sidecar (pre-sidecar state) are skipped, not
 *  guessed at; keys whose repo still exists are left alone. */
export function gcSweep(dataDir: string): GcSweepResult {
  const dbDir = join(dataDir, "db");
  const result: GcSweepResult = { swept: [], skipped: [] };
  const entries = existsSync(dbDir)
    ? readdirSync(dbDir).filter((f) => f.endsWith(".db")).map((f) => f.slice(0, -3))
    : [];
  for (const key of entries) {
    const logDir = join(dataDir, "logs", key);
    const sidecar = join(logDir, "repo-root");
    if (!existsSync(sidecar)) {
      result.skipped.push({ key, reason: "no repo-root sidecar (state predates crw gc) — use crw gc --repo <path>" });
      continue;
    }
    const repoRoot = readFileSync(sidecar, "utf8").trim();
    if (existsSync(repoRoot)) {
      result.skipped.push({ key, reason: `repo still exists: ${repoRoot}` });
      continue;
    }
    const db = join(dbDir, `${key}.db`);
    result.swept.push({ key, repoRoot, removed: removePaths([db, `${db}-wal`, `${db}-shm`, logDir]) });
  }
  return result;
}
