import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
let launcher: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crw-plugin-test-"));
  for (const name of ["package/scripts", "package/dist", "bin"]) mkdirSync(join(dir, name), { recursive: true });
  launcher = join(dir, "package/scripts/crw.mjs");
  writeFileSync(launcher, readFileSync(fileURLToPath(new URL("../../../scripts/plugin-launcher.mjs", import.meta.url))));
  writeFileSync(join(dir, "package/package.json"), '{"dependencies":{"test":"1"}}');
  writeFileSync(join(dir, "package/dist/crw.js"), 'console.log(JSON.stringify({ args: process.argv.slice(2), data: process.env.CRW_DATA_DIR, indexers: process.env.CRW_INDEXER_HOME }));');
  // An actual child executable simulates npm, including interrupted installs.
  writeFileSync(join(dir, "bin/npm"), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync('install-count', '1');
console.log('npm progress');
if (process.env.CRW_TEST_FAIL === '1') process.exit(1);
fs.mkdirSync('node_modules/.bin', { recursive: true });
for (const bin of ['scip-typescript', 'scip-python']) fs.writeFileSync('node_modules/.bin/' + bin, 'ready');
`, { mode: 0o755 });
  env = { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, CRW_DATA_DIR: join(dir, "writable data"), CRW_INDEXER_HOME: "", GRAPH_PROVIDER: "scip" };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (...args: string[]) => execFileSync(process.execPath, [launcher, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe("portable plugin launcher", () => {
  it("bootstraps without a hook, preserves JSON stdout and reuses the installation", () => {
    const first = JSON.parse(run("serve", "--repo", "/some repo"));
    expect(first.args).toEqual(["serve", "--repo", "/some repo"]);
    expect(first.data).toBe(env.CRW_DATA_DIR);
    expect(first.indexers).toBe(env.CRW_DATA_DIR);
    run("serve");
    expect(readFileSync(join(env.CRW_DATA_DIR!, "install-count"), "utf8")).toBe("1");
    expect(existsSync(join(dir, "package/node_modules"))).toBe(false);
  });

  it("reports an install failure and retries successfully on the next invocation", () => {
    const failed = spawnSync(process.execPath, [launcher, "serve"], { env: { ...env, CRW_TEST_FAIL: "1" }, encoding: "utf8" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("retry the same command");
    expect(existsSync(join(env.CRW_DATA_DIR!, ".indexers-ready"))).toBe(false);
    expect(JSON.parse(run("serve")).args).toEqual(["serve"]);
    expect(readFileSync(join(env.CRW_DATA_DIR!, "install-count"), "utf8")).toBe("11");
  });

  it("keeps help and shutdown usable without installing indexers", () => {
    expect(JSON.parse(run("--help")).args).toEqual(["--help"]);
    expect(JSON.parse(run("shutdown")).args).toEqual(["shutdown"]);
    expect(existsSync(env.CRW_DATA_DIR!)).toBe(false);
  });

  it("keeps the --setup hook best-effort: a failed install warns but exits 0", () => {
    const failed = spawnSync(process.execPath, [launcher, "--setup"], { env: { ...env, CRW_TEST_FAIL: "1" }, encoding: "utf8" });
    expect(failed.status).toBe(0);
    expect(failed.stderr).toContain("retry");
    expect(existsSync(join(env.CRW_DATA_DIR!, ".indexers-ready"))).toBe(false);
    // The next real command still bootstraps for itself.
    expect(JSON.parse(run("serve")).args).toEqual(["serve"]);
    expect(readFileSync(join(env.CRW_DATA_DIR!, "install-count"), "utf8")).toBe("11");
  });

  it("bootstraps indexers when flags precede the command word", () => {
    run("--pretty", "serve");
    run("session", "--port", "4000", "create");
    expect(readFileSync(join(env.CRW_DATA_DIR!, "install-count"), "utf8")).toBe("1");
  });

  it("uses Codex's plugin data directory when no explicit override was supplied", () => {
    env = { ...env, CRW_DATA_DIR: "", PLUGIN_DATA: join(dir, "codex data"), CLAUDE_PLUGIN_DATA: join(dir, "claude data") };
    expect(JSON.parse(run("serve")).data).toBe(env.PLUGIN_DATA);
  });

  it("repairs an incomplete install even when its success marker survived", () => {
    run("serve");
    rmSync(join(env.CRW_DATA_DIR!, "node_modules/.bin/scip-python"));
    run("serve");
    expect(readFileSync(join(env.CRW_DATA_DIR!, "install-count"), "utf8")).toBe("11");
  });
});
