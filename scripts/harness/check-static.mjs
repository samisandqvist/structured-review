import { ESLint } from "eslint";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { lintFindings, knipFindings, newFindings } from "./debt.mjs";

export async function collectStaticFindings(root) {
  const eslint = new ESLint({ cwd: root, errorOnUnmatchedPattern: false });
  const results = await eslint.lintFiles([
    "packages",
    "scripts",
    "tests",
    "*.config.{mjs,ts}",
    ".dependency-cruiser.cjs",
  ]);
  const knip = spawnSync("pnpm", ["exec", "knip", "--reporter", "json"], {
    cwd: root,
    encoding: "utf8",
  });
  if (knip.error || ![0, 1].includes(knip.status)) throw new Error(`Knip unavailable: ${knip.stderr}`);
  return { lint: lintFindings(results, root), unused: knipFindings(JSON.parse(knip.stdout)) };
}

export async function checkStaticMain({
  root,
  args,
  collect = collectStaticFindings,
  log = console.log,
  error = console.error,
}) {
  const strict = args.includes("--strict");
  const baseline = JSON.parse(readFileSync(join(root, ".harness/static-baseline.json"), "utf8"));
  const findings = await collect(root);
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(join(root, "reports/static.json"), JSON.stringify(findings, null, 2));
  const failures = Object.entries(findings).flatMap(([kind, values]) =>
    strict ? values : newFindings(values, baseline[kind]),
  );
  log(
    `${strict ? "STRICT" : "TRANSITIONAL"} static: ${findings.lint.length} lint, ${findings.unused.length} unused-code findings; ${failures.length} blocking`,
  );
  for (const failure of failures) error(failure);
  return failures.length ? 1 : 0;
}

export async function checkStaticCli({
  metaUrl = import.meta.url,
  argv = process.argv,
  root = process.cwd(),
  main = checkStaticMain,
} = {}) {
  if (!argv[1] || metaUrl !== pathToFileURL(resolve(argv[1])).href) return undefined;
  const code = await main({ root, args: argv.slice(2) });
  process.exitCode = code;
  return code;
}

await checkStaticCli();
