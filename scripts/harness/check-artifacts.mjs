import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { artifactDifferences, snapshotArtifacts } from "./artifacts.mjs";

const artifactPaths = [
  "plugin/dist",
  "plugin/web",
  "plugin/skills",
  "plugin/scripts",
  "plugin/LICENSE",
  "plugins/structured-review",
];
export function buildPluginArtifacts(root, output) {
  const webDist = join(output, "web-dist");
  execFileSync("pnpm", ["--filter", "@srev/web", "exec", "vite", "build", "--outDir", webDist, "--emptyOutDir"], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "production" },
    stdio: "inherit",
  });
  execFileSync(process.execPath, ["scripts/build-plugin.mjs"], {
    cwd: root,
    env: { ...process.env, SREV_PLUGIN_OUTPUT_ROOT: output, SREV_WEB_DIST: webDist },
    stdio: "inherit",
  });
}

export function checkArtifactsMain({ root, build = buildPluginArtifacts, log = console.log, error = console.error }) {
  const output = mkdtempSync(join(tmpdir(), "srev-artifact-check-"));
  try {
    mkdirSync(join(output, "plugin/skills/structured-review"), { recursive: true });
    cpSync(join(root, "plugin/.claude-plugin"), join(output, "plugin/.claude-plugin"), { recursive: true });
    cpSync(join(root, "plugin/package.json"), join(output, "plugin/package.json"));
    build(root, output);
    const differences = artifactDifferences(
      snapshotArtifacts(root, artifactPaths),
      snapshotArtifacts(output, artifactPaths),
    );
    log(`Plugin freshness: ${differences.length ? "FAIL" : "PASS"}`);
    for (const path of differences) error(path);
    return differences.length ? 1 : 0;
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

export function checkArtifactsCli({
  metaUrl = import.meta.url,
  argv = process.argv,
  root = process.cwd(),
  main = checkArtifactsMain,
} = {}) {
  if (!argv[1] || metaUrl !== pathToFileURL(resolve(argv[1])).href) return undefined;
  const code = main({ root });
  process.exitCode = code;
  return code;
}

checkArtifactsCli();
