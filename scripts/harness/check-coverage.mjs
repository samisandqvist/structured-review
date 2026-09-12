import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCoverage } from "./coverage-run.mjs";

export function checkCoverageMain({ root, args, env, log = console.log }) {
  const result = runCoverage({
    root,
    strict: args.includes("--strict"),
    changed: args.includes("--changed"),
    baseRef: env.HARNESS_BASE || "main",
  });
  log(JSON.stringify(result, null, 2));
  return result.failures.length ? 1 : 0;
}

export function checkCoverageCli({
  metaUrl = import.meta.url,
  argv = process.argv,
  root = process.cwd(),
  env = process.env,
  main = checkCoverageMain,
} = {}) {
  if (!argv[1] || metaUrl !== pathToFileURL(resolve(argv[1])).href) return undefined;
  const code = main({ root, args: argv.slice(2), env });
  process.exitCode = code;
  return code;
}

checkCoverageCli();
