// packages/skill/src/serve.ts — review hub lifecycle for `crw serve`.
// Probe /health; reuse a healthy hub serving the same repo, refuse a port
// occupied by anything else, otherwise spawn the built server detached.
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Health { ok: boolean; repoRoot?: string; pid?: number; provider?: string; }
export interface ServeResult {
  baseUrl: string; repoRoot: string; pid: number; provider: string; reused: boolean; logFile?: string;
}

export function resolveGitRoot(dir: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" }).trim();
  } catch {
    throw new Error(`not a git repository: ${dir}`);
  }
}

export async function probeHealth(base: string): Promise<Health | null> {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return (await res.json()) as Health;
  } catch {
    return null;
  }
}

export type ServeAction = { action: "reuse" } | { action: "spawn" } | { action: "conflict"; reason: string };

/** Pure reuse/spawn/conflict decision, given the probe result and the wanted repo root. */
export function decideServe(health: Health | null, wantRoot: string): ServeAction {
  if (health === null) return { action: "spawn" };
  if (health.ok && health.repoRoot === wantRoot) return { action: "reuse" };
  const serving = health.repoRoot ? `a hub serving ${health.repoRoot}` : "something that answers /health without a repoRoot";
  return { action: "conflict", reason: `port is occupied by ${serving} — pick another --port or stop it (pid ${health.pid ?? "unknown"})` };
}

/** The server entry ships next to this package: packages/skill/{src,dist} → packages/server/dist. */
export function serverEntryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "server", "dist", "index.js");
}

export async function ensureServer(opts: { repo: string; port: number }): Promise<ServeResult> {
  const repoRoot = resolveGitRoot(opts.repo);
  const baseUrl = `http://127.0.0.1:${opts.port}`;

  const health = await probeHealth(baseUrl);
  const decision = decideServe(health, repoRoot);
  if (decision.action === "conflict") throw new Error(decision.reason);
  if (decision.action === "reuse") {
    return { baseUrl, repoRoot, pid: health!.pid ?? -1, provider: health!.provider ?? "unknown", reused: true };
  }

  const entry = serverEntryPath();
  if (!existsSync(entry)) throw new Error(`server not built (${entry} missing) — run: pnpm build`);

  const crwDir = join(repoRoot, ".crw");
  mkdirSync(crwDir, { recursive: true });
  const logFile = join(crwDir, "server.log");
  const logFd = openSync(logFile, "a");
  const child = spawn(process.execPath, [entry], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(opts.port) },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);

  // Startup is fast (indexing happens per-session), but give slow disks room.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const h = await probeHealth(baseUrl);
    if (h?.ok) {
      if (h.repoRoot !== repoRoot) {
        throw new Error(`hub came up serving ${h.repoRoot ?? "unknown"}, expected ${repoRoot} — see ${logFile}`);
      }
      return { baseUrl, repoRoot, pid: h.pid ?? child.pid ?? -1, provider: h.provider ?? "unknown", reused: false, logFile };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`hub did not become healthy within 15s — see ${logFile}`);
}
