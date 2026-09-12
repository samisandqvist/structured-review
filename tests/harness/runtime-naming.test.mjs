import { afterEach, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scratch = [];
const argv = process.argv;
const exitCode = process.exitCode;
function temporary() {
  const path = mkdtempSync(join(tmpdir(), "srev-runtime-test-"));
  scratch.push(path);
  return path;
}
afterEach(() => {
  process.argv = argv;
  process.exitCode = exitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.doUnmock("node:url");
  vi.doUnmock("node:child_process");
  vi.resetModules();
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("builds installable host packages whose renamed CLI and launcher both execute", async () => {
  const output = temporary();
  mkdirSync(join(output, "plugin/skills/structured-review"), { recursive: true });
  cpSync(join(root, "plugin/.claude-plugin"), join(output, "plugin/.claude-plugin"), { recursive: true });
  cpSync(join(root, "plugin/package.json"), join(output, "plugin/package.json"));
  vi.stubEnv("SREV_PLUGIN_OUTPUT_ROOT", output);
  vi.stubEnv("SREV_WEB_DIST", join(root, "packages/web/dist"));
  await import("../../scripts/build-plugin.mjs");
  for (const host of ["plugin", "plugins/structured-review"]) {
    const manifest = host === "plugin" ? ".claude-plugin/plugin.json" : ".codex-plugin/plugin.json";
    expect(JSON.parse(readFileSync(join(output, host, manifest), "utf8"))).toMatchObject({
      name: "structured-review",
    });
    const launcher = join(output, host, "scripts/srev.mjs");
    const result = spawnSync(process.execPath, [launcher, "--help"], { encoding: "utf8" });
    expect(result.stderr).toContain("srev session create");
    expect(existsSync(join(output, host, "skills/structured-review/SKILL.md"))).toBe(true);
  }
});

async function launcherFixture() {
  const output = temporary();
  mkdirSync(join(output, "dist"));
  const resultPath = join(output, "result.json");
  writeFileSync(
    join(output, "dist/srev.js"),
    `require('node:fs').writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({data:process.env.SREV_DATA_DIR,indexers:process.env.SREV_INDEXER_HOME,args:process.argv.slice(2)}));`,
  );
  vi.doMock("node:url", async () => {
    const actual = await vi.importActual("node:url");
    return {
      ...actual,
      fileURLToPath: (url) =>
        String(url).endsWith("/scripts/plugin-launcher.mjs")
          ? join(output, "scripts/srev.mjs")
          : actual.fileURLToPath(url),
    };
  });
  vi.stubEnv("SREV_DATA_DIR", "");
  vi.stubEnv("SREV_INDEXER_HOME", "");
  vi.stubEnv("PLUGIN_DATA", "");
  vi.stubEnv("CLAUDE_PLUGIN_DATA", "");
  vi.stubEnv("XDG_DATA_HOME", join(output, "xdg"));
  return { output, resultPath };
}

it("launches the new executable with the Structured Review XDG fallback", async () => {
  const { output, resultPath } = await launcherFixture();
  process.argv = [process.execPath, "srev.mjs", "--help"];
  await import("../../scripts/plugin-launcher.mjs");
  expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual({
    data: join(output, "xdg/structured-review"),
    indexers: join(output, "xdg/structured-review"),
    args: ["--help"],
  });
});

it("reports a missing explicit indexer directory using the new environment name", async () => {
  const { output, resultPath } = await launcherFixture();
  vi.stubEnv("GRAPH_PROVIDER", "scip");
  vi.stubEnv("SREV_INDEXER_HOME", join(output, "missing-indexers"));
  process.argv = [process.execPath, "srev.mjs", "serve"];
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await import("../../scripts/plugin-launcher.mjs");
  expect(process.exitCode).toBe(1);
  expect(errors.mock.calls.flat().join(" ")).toContain("Missing indexers in SREV_INDEXER_HOME");
  expect(existsSync(resultPath)).toBe(false);
});

it("bootstraps indexers into the renamed data directory before dispatching", async () => {
  const { output, resultPath } = await launcherFixture();
  vi.stubEnv("GRAPH_PROVIDER", "scip");
  writeFileSync(join(output, "package.json"), '{"private":true}');
  const bin = join(output, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!${process.execPath}\nconst fs=require('node:fs');fs.mkdirSync('node_modules/.bin',{recursive:true});for(const bin of ['scip-typescript','scip-python'])fs.writeFileSync('node_modules/.bin/'+bin,'ready');`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  process.argv = [process.execPath, "srev.mjs", "serve"];
  await import("../../scripts/plugin-launcher.mjs");
  const data = join(output, "xdg/structured-review");
  expect(existsSync(join(data, ".indexers-ready"))).toBe(true);
  expect(JSON.parse(readFileSync(resultPath, "utf8")).data).toBe(data);
});

it("runs the renamed demo through a real hub and shuts it down after a planning failure", async () => {
  const outputs = [];
  vi.spyOn(console, "error").mockImplementation((message) => outputs.push(message));
  vi.doMock("node:child_process", async () => {
    const actual = await vi.importActual("node:child_process");
    return {
      ...actual,
      execFileSync: (file, args, options) => {
        if (file === process.execPath && args[1] === "plan") throw new Error("planning interrupted");
        return actual.execFileSync(file, args, options);
      },
    };
  });
  await import("../../scripts/demo.mjs");
  await vi.waitFor(() => expect(outputs.join("\n")).toContain("Demo failed: planning interrupted"), {
    timeout: 15_000,
  });
  const workspace = outputs.join("\n").match(/Temporary files: (.+)/)[1];
  scratch.push(workspace);
  expect(existsSync(join(workspace, "plan.json"))).toBe(true);
  expect(process.exitCode).toBe(1);
}, 20_000);

it("starts the source CLI with renamed state paths and garbage-collects that state", async () => {
  const workspace = temporary();
  execFileSync("git", ["init", "-b", "main", workspace], { stdio: "pipe" });
  vi.stubEnv("SREV_DATA_DIR", join(workspace, "state"));
  vi.stubEnv("GRAPH_PROVIDER", "stub");
  const { createServer } = await import("node:net");
  const probe = createServer();
  await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  const { runCli } = await import("../../packages/skill/src/cli.ts");
  const { statePaths } = await import("../../packages/skill/src/serve.ts");
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await runCli(["serve", "--repo", workspace, "--port", String(port)]);
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    expect(health.repoRoot).toBe(workspace);
    expect(existsSync(statePaths(workspace).dbPath)).toBe(true);
    await runCli(["gc", "--all"]);
    expect(JSON.parse(output.mock.calls.at(-1)[0]).skipped).toHaveLength(1);
  } finally {
    await runCli(["shutdown", "--port", String(port)]);
    await vi.waitFor(async () => {
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    });
  }
  await runCli(["gc", "--repo", workspace, "--port", String(port)]);
  expect(JSON.parse(output.mock.calls.at(-1)[0]).removed.length).toBeGreaterThan(0);
  await runCli(["gc", "--repo", workspace, "--port", String(port)]);
  expect(JSON.parse(output.mock.calls.at(-1)[0]).removed).toEqual([]);
  await runCli(["gc", "--all", "--pretty"]);
  expect(output.mock.calls.at(-1)[0]).toBe("nothing to sweep");
  vi.stubEnv("SREV_DATA_DIR", "");
  await expect(runCli(["gc", "--all"])).rejects.toThrow("SREV_DATA_DIR");
});
