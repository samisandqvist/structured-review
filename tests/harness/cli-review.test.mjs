import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMemoryDatabase } from "../../packages/server/src/db/connection.ts";
import { createApp } from "../../packages/server/src/app.ts";
import { StubGraphProvider } from "../../packages/server/src/graph/stub.ts";
import { runCli } from "../../packages/skill/src/cli.ts";

let db, app, directory, output;
const exitCode = process.exitCode;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "srev-cli-review-"));
  execFileSync("git", ["init", "-b", "main", directory], { stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-C",
      directory,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--allow-empty",
      "-m",
      "Initial",
    ],
    { stdio: "pipe" },
  );
  db = createMemoryDatabase();
  app = createApp({ db, graphProvider: new StubGraphProvider(), repoRoot: directory });
  vi.stubGlobal("fetch", (url, init) => app.request(String(url), init));
  output = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
  process.exitCode = exitCode;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function command(...args) {
  await runCli(args);
  const text = output.mock.calls.at(-1)[0];
  return args.includes("--pretty") ? text : JSON.parse(text);
}

it("creates, plans, reviews and deletes a session through the source CLI", async () => {
  expect(await command("session", "list", "--pretty")).toBe("no sessions");
  const session = await command("session", "create", "--base", "main");
  const id = session.sessionId;
  expect((await command("session", "list")).sessions[0].id).toBe(id);
  for (const flags of [[], ["--brief"], ["--full"]]) {
    expect(await command("context", "--session", id, ...flags)).toMatchObject({ sessionId: id });
  }
  const plan = await command("plan", "--session", id, "--auto");
  // This provider supplies two changed nodes but no flows to auto-partition.
  expect(plan.coverage.unassigned).toBe(2);
  expect(await command("status", "--session", id, "--pretty")).toContain(id);
  expect(await command("comments", "--session", id, "--pretty")).toBe("no comments");
  expect(await command("wait", "--session", id, "--timeout", "0")).toMatchObject({ met: false, timedOut: true });
  const response = await app.request(`/api/sessions/${id}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Review note" }),
  });
  expect(response.status).toBe(200);
  expect(await command("wait", "--session", id, "--until", "commented", "--interval", "0.01")).toMatchObject({
    met: true,
    commentCount: 1,
  });
  expect(await command("comments", "--session", id, "--pretty")).toContain("Review note");
  await expect(command("diff", "--session", id, "--node", "missing")).rejects.toThrow("no node with stableId");
  expect(await command("session", "delete", "--session", id)).toEqual({ deleted: id });
  expect((await command("session", "list")).sessions).toEqual([]);
});

it("accepts a authored plan file and rejects incomplete CLI requests", async () => {
  const { sessionId: id } = await command("session", "create", "--branch", "main", "--base", "main");
  const plan = join(directory, "plan.json");
  writeFileSync(plan, JSON.stringify({ overview: "Review rationale", units: [] }));
  expect(await command("plan", "--session", id, "--units", plan)).toMatchObject({ overview: "Review rationale" });
  expect(await command("status", "--session", id, "--pretty")).toContain("overview: Review rationale");
  await expect(command("plan", "--session", id)).rejects.toThrow("--auto or --units");
  await expect(command("status")).rejects.toThrow("--session");
  await expect(command("status", "--session")).rejects.toThrow("--session");
  await expect(command()).rejects.toThrow("srev session create");
  await expect(command("invalid-command")).rejects.toThrow("unknown command");
});

it("accepts the minimum Node runtime and gives a named upgrade error for older versions", async () => {
  const original = Object.getOwnPropertyDescriptor(process.versions, "node");
  try {
    Object.defineProperty(process.versions, "node", { ...original, value: "22.13.0" });
    expect(await command("session", "list")).toEqual({ sessions: [] });
    Object.defineProperty(process.versions, "node", { ...original, value: "22.12.0" });
    await expect(command("session", "list")).rejects.toThrow("srev requires Node >= 22.13");
  } finally {
    Object.defineProperty(process.versions, "node", original);
  }
});
