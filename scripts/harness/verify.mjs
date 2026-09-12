import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runChecks } from "./runner.mjs";

export function verificationNames({ strict, full }) {
  const names = [
    "typecheck",
    "format:check",
    strict ? "lint:strict" : "lint",
    "architecture",
    // Runtime integration tests execute the built CLI, server, and web UI.
    "build",
    "test:coverage",
    strict ? "coverage:strict" : "coverage:check",
    "plugin:check",
    "test:e2e",
    "security:check",
    "security:probe",
  ];
  if (full) names.push("test:mutation");
  return names;
}

export function spawnCommand([command, ...args], log = console.log, cwd) {
  return new Promise((finish) => {
    log(`\n--- ${args.at(-1)} ---`);
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", () => finish(1));
    child.on("exit", (code) => finish(code ?? 1));
  });
}

export async function verifyMain({ root, args, execute = spawnCommand, log = console.log, table = console.table }) {
  const strict = args.includes("--strict");
  const full = args.includes("--full");
  const checks = verificationNames({ strict, full }).map((name) => ({
    name,
    command: ["pnpm", "run", name],
  }));
  const result = await runChecks(checks, (command) => execute(command, log, root));
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(
    join(root, `reports/verify${strict ? "-strict" : full ? "-full" : ""}.json`),
    JSON.stringify(
      {
        ...result,
        executedAt: new Date().toISOString(),
        policy: strict ? "strict" : "transitional",
        mutationIncluded: full,
      },
      null,
      2,
    ),
  );
  table(result.checks);
  return result.ok ? 0 : 1;
}

export async function verifyCli({
  metaUrl = import.meta.url,
  argv = process.argv,
  root = process.cwd(),
  main = verifyMain,
} = {}) {
  if (!argv[1] || metaUrl !== pathToFileURL(resolve(argv[1])).href) return undefined;
  const code = await main({ root, args: argv.slice(2) });
  process.exitCode = code;
  return code;
}

await verifyCli();
