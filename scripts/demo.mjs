// A disposable example driven exclusively through the public srev CLI.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(project, "packages/skill/dist/cli.js");
if (!existsSync(cli) || !existsSync(join(project, "packages/web/dist/index.html"))) {
  console.error("Build the project first: pnpm install && pnpm build");
  process.exit(1);
}
async function main() {
  const workspace = mkdtempSync(join(tmpdir(), "srev-demo-"));
  const repo = join(workspace, "orders");
  mkdirSync(join(repo, "src"), { recursive: true });
  function write(path, text) {
    writeFileSync(join(repo, path), text);
  }
  function git(...args) {
    return execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  }
  git("init", "-b", "main");
  git("config", "user.name", "Review demo");
  git("config", "user.email", "demo@example.invalid");
  write("package.json", JSON.stringify({ name: "orders-demo", private: true, type: "module" }));
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { module: "esnext", moduleResolution: "bundler", strict: true },
      include: ["src"],
    }),
  );
  write(
    "src/pricing.ts",
    "export function total(unitPrice: number, quantity: number): number {\n  return unitPrice * quantity;\n}\n",
  );
  write(
    "src/orders.ts",
    'import { total } from "./pricing.js";\nexport function submitOrder(unitPrice: number): number {\n  return total(unitPrice, 1);\n}\n',
  );
  write(
    "src/pricing.test.ts",
    'import { total } from "./pricing.js";\nexport function testTotal(): boolean {\n  return total(10, 2) === 20;\n}\n',
  );
  git("add", ".");
  git("-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Start with single-item orders");
  write(
    "src/pricing.ts",
    "export function total(unitPrice: number, quantity: number): number {\n  const discount = quantity >= 10 ? 0.9 : 1;\n  return unitPrice * quantity * discount;\n}\n",
  );
  write(
    "src/orders.ts",
    'import { total } from "./pricing.js";\nexport function submitOrder(unitPrice: number, quantity: number): number {\n  return total(unitPrice, quantity);\n}\n',
  );
  write(
    "src/pricing.test.ts",
    'import { total } from "./pricing.js";\nexport function testTotal(): boolean {\n  return total(10, 2) === 20 && total(10, 10) === 90;\n}\n',
  );

  // Let the OS choose a free port so this never reuses a personal review hub.
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const env = {
    ...process.env,
    GRAPH_PROVIDER: "scip",
    SCIP_REPO_ROOT: repo,
    SREV_DATA_DIR: join(workspace, "data"),
    SREV_INDEXER_HOME: join(project, "packages/server"),
    SREV_SERVER_URL: `http://127.0.0.1:${port}`,
  };
  function srev(...args) {
    return JSON.parse(
      execFileSync(process.execPath, [cli, ...args], {
        cwd: repo,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      }),
    );
  }
  let running = false;
  try {
    srev("serve", "--repo", repo, "--port", String(port));
    running = true;
    const session = srev("session", "create", "--branch", "HEAD", "--base", "HEAD");
    const context = srev("context", "--session", session.sessionId, "--brief");
    const planPath = join(workspace, "plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        overview:
          "Orders now accept a quantity, with a 10% discount at ten items. Follow submitOrder into pricing, then inspect the attached tests. Consider which inputs the new quantity parameter permits.",
        units: context.flows.map((flow) => ({
          kind: "flow",
          flowIds: [flow.id],
          label: "Order quantities and bulk pricing",
          rationale: "The order entry passes a new quantity through to the discount calculation.",
        })),
      }),
    );
    srev("plan", "--session", session.sessionId, "--units", planPath);
    const quotedCli = "'" + cli.replaceAll("'", "'\\''") + "'";
    console.log(
      `Example review: ${session.uiUrl}\n\nTry j to start, r to mark reviewed, and c to leave a comment.\nDoes the new quantity need validation? Use Review notes for broader concerns.\n\nTemporary example: ${workspace}\nStop its hub: node ${quotedCli} shutdown --port ${port}`,
    );
  } catch (error) {
    if (running) {
      try {
        srev("shutdown");
      } catch {
        /* preserve original error */
      }
    }
    console.error(`Demo failed: ${error.message}\nTemporary files: ${workspace}`);
    process.exitCode = 1;
  }
}
main().catch((error) => {
  console.error(`Demo setup failed: ${error.message}`);
  process.exitCode = 1;
});
