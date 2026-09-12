// Copied to each plugin's scripts/crw.mjs by build-plugin.mjs.
// Resolve immutable assets from this file, and keep mutable state outside the
// plugin cache and reviewed checkout. Do not depend on a SessionStart hook.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error("crw requires Node >= 22.13. Upgrade Node and retry.");
  process.exit(1);
}

const data = resolve(
  process.env.CRW_DATA_DIR ||
    process.env.PLUGIN_DATA ||
    process.env.CLAUDE_PLUGIN_DATA ||
    join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "code-review-walkthrough"),
);
const indexers = resolve(process.env.CRW_INDEXER_HOME || data);
const env = { ...process.env, CRW_DATA_DIR: data, CRW_INDEXER_HOME: indexers };
const setup = args[0] === "--setup";
// Positionals as the wrapped CLI parses them: flags may appear anywhere, and
// non-boolean flags consume the next token. Keep BOOL_FLAGS in sync with
// packages/skill/src/cli.ts.
const BOOL_FLAGS = new Set(["auto", "open", "pretty", "all", "full", "brief"]);
const positionals = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    if (!BOOL_FLAGS.has(args[i].slice(2))) i++;
  } else {
    positionals.push(args[i]);
  }
}
// Only commands that need indexing bootstrap it. Help, status, export and
// shutdown must remain usable offline, including after an installation failure.
const needsIndexers =
  setup || positionals[0] === "serve" || (positionals[0] === "session" && positionals[1] === "create");

function indexersPresent() {
  return ["scip-typescript", "scip-python"].every((bin) => existsSync(join(indexers, "node_modules", ".bin", bin)));
}

try {
  if (needsIndexers && (!env.GRAPH_PROVIDER || env.GRAPH_PROVIDER === "scip")) {
    if (process.env.CRW_INDEXER_HOME && indexers !== data) {
      if (!indexersPresent())
        throw new Error(
          `Missing indexers in CRW_INDEXER_HOME (${indexers}). Install them there or unset the override.`,
        );
    } else {
      const manifest = readFileSync(join(root, "package.json"), "utf8");
      const key = createHash("sha256").update(manifest).digest("hex");
      const marker = join(data, ".indexers-ready");
      const ready = existsSync(marker) && readFileSync(marker, "utf8") === key && indexersPresent();
      if (!ready) {
        mkdirSync(data, { recursive: true });
        writeFileSync(join(data, "package.json"), manifest);
        console.error(`Installing review indexers in ${data}. This can take a minute on first use.`);
        // Send npm output to stderr: crw's stdout remains machine-readable JSON.
        // Windows npm is npm.cmd, which Node only spawns through a shell (the
        // arguments are fixed strings, so shell interpolation is not a concern).
        const win = process.platform === "win32";
        const install = spawnSync(win ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund"], {
          cwd: data,
          env,
          stdio: ["ignore", 2, 2],
          shell: win,
        });
        if (install.error || install.status !== 0 || !indexersPresent()) {
          throw new Error(
            `Indexer installation failed${install.error ? `: ${install.error.message}` : ""}. Check npm/network access and retry the same command.`,
          );
        }
        // Only record success after npm and the executable checks succeed.
        writeFileSync(marker, key);
      }
    }
  }
  if (!setup) {
    const child = spawnSync(process.execPath, [join(root, "dist", "crw.js"), ...args], { env, stdio: "inherit" });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  }
} catch (error) {
  console.error(`crw: ${error.message}`);
  // --setup is a best-effort pre-warm run by session-start hooks: a failure
  // (offline, registry down) must not surface a hook error on every session.
  // Real commands bootstrap for themselves and do fail loudly.
  process.exitCode = setup ? 0 : 1;
}
