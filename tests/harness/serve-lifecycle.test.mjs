import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const scenario = vi.hoisted(() => ({ missing: false, sibling: false, pid: 42 }));
vi.mock("node:child_process", async (original) => ({
  ...(await original()),
  spawn: () => ({ pid: scenario.pid, unref() {} }),
}));
vi.mock("node:fs", async (original) => {
  const actual = await original();
  return {
    ...actual,
    existsSync: (path) => {
      if (String(path).endsWith("/src/server.js")) return scenario.sibling;
      if (String(path).endsWith("/server/dist/index.js")) return !scenario.missing;
      return actual.existsSync(path);
    },
  };
});
import { ensureServer, probeHealth, repoStateKey, serverEntryPath } from "../../packages/skill/src/serve.ts";
import { gcRepo, stopHubIfServing } from "../../packages/skill/src/gc.ts";
let directory, fetchMock;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "srev-lifecycle-"));
  execFileSync("git", ["init", "-b", "main", directory], { stdio: "pipe" });
  scenario.missing = false;
  scenario.sibling = false;
  scenario.pid = 42;
  vi.stubEnv("SREV_DATA_DIR", "");
  vi.useFakeTimers();
  fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it("cleans repo-local state without stopping unrelated or unhealthy hubs", async () => {
  writeFileSync(join(directory, "review.db"), "disposable state");
  fetchMock.mockResolvedValueOnce(healthy({ repoRoot: "/other" }));
  expect(await gcRepo(directory, "http://localhost")).toMatchObject({
    hubStopped: false,
    removed: [join(directory, "review.db")],
  });
  expect(existsSync(join(directory, "review.db"))).toBe(false);
  fetchMock.mockResolvedValueOnce(Response.json({ ok: false }));
  expect(await stopHubIfServing("http://localhost", directory)).toBe(false);
});

it("waits for the matching hub to stop before allowing state cleanup", async () => {
  fetchMock.mockResolvedValueOnce(healthy({ repoRoot: directory })).mockResolvedValueOnce(Response.json({ ok: true }));
  expect(await stopHubIfServing("http://localhost", directory)).toBe(true);
});

it("uses the reported pid only when shutdown fails, and refuses to guess a missing pid", async () => {
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  fetchMock
    .mockResolvedValueOnce(healthy({ repoRoot: directory, pid: 12345 }))
    .mockResolvedValueOnce(new Response("unsupported", { status: 404 }));
  expect(await stopHubIfServing("http://localhost", directory)).toBe(true);
  expect(kill).toHaveBeenCalledWith(12345, "SIGTERM");
  fetchMock
    .mockResolvedValueOnce(healthy({ repoRoot: directory }))
    .mockResolvedValueOnce(new Response("unsupported", { status: 404 }));
  await expect(stopHubIfServing("http://localhost", directory)).rejects.toThrow("no pid");
  expect(kill).toHaveBeenCalledTimes(1);
});

it("leaves state in place when the matching hub refuses to stop", async () => {
  const file = join(directory, "review.db");
  writeFileSync(file, "disposable state");
  fetchMock.mockImplementation(async () => healthy({ repoRoot: directory }));
  const pending = expect(gcRepo(directory, "http://localhost")).rejects.toThrow("DB was left in place");
  await vi.runAllTimersAsync();
  await pending;
  expect(existsSync(file)).toBe(true);
});
const healthy = (data) => Response.json({ ok: true, ...data });

it("reuses only the requested repo and refuses another repo on the same port", async () => {
  fetchMock.mockResolvedValueOnce(healthy({ repoRoot: directory }));
  expect(await ensureServer({ repo: directory, port: 3456 })).toMatchObject({
    reused: true,
    pid: -1,
    provider: "unknown",
  });
  fetchMock.mockResolvedValueOnce(healthy({ repoRoot: "/other" }));
  await expect(ensureServer({ repo: directory, port: 3456 })).rejects.toThrow("port is occupied");
});

it("reports invalid repos, unsuccessful health responses and missing builds", async () => {
  await expect(ensureServer({ repo: join(directory, "missing"), port: 3456 })).rejects.toThrow("not a git repository");
  fetchMock.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
  expect(await probeHealth("http://localhost")).toBeNull();
  scenario.missing = true;
  await expect(ensureServer({ repo: directory, port: 3456 })).rejects.toThrow("server not built");
  scenario.sibling = true;
  expect(serverEntryPath()).toMatch(/\/src\/server.js$/);
  expect(repoStateKey("/")).toMatch(/^repo-/);
});

it.each([42, undefined])("starts in repo-local state and handles a missing health pid (child pid %s)", async (pid) => {
  scenario.pid = pid;
  fetchMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(healthy({ repoRoot: directory }));
  const result = await ensureServer({ repo: directory, port: 3456 });
  expect(result).toMatchObject({
    reused: false,
    pid: pid ?? -1,
    provider: "unknown",
    logFile: join(directory, ".srev/server.log"),
  });
});

it("rejects the wrong repo after spawn and times out when startup never succeeds", async () => {
  fetchMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(healthy({ repoRoot: "/other" }));
  await expect(ensureServer({ repo: directory, port: 3456 })).rejects.toThrow("hub came up serving /other");
  const pending = expect(ensureServer({ repo: directory, port: 3456 })).rejects.toThrow("did not become healthy");
  await vi.runAllTimersAsync();
  await pending;
});
