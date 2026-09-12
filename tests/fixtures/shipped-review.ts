import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const shippedCli = join(projectRoot, "plugin", "dist", "srev.js");

interface CommandFailure extends Error {
  stdout?: string;
  stderr?: string;
  code?: number;
}

export interface ShippedReview {
  workspace: string;
  repo: string;
  otherRepo: string;
  dataDir: string;
  port: number;
  baseUrl: string;
  env: NodeJS.ProcessEnv;
  srev<T = Record<string, unknown>>(...args: string[]): Promise<T>;
  srevFrom<T = Record<string, unknown>>(cwd: string, ...args: string[]): Promise<T>;
  srevFailure(...args: string[]): Promise<CommandFailure>;
  stop(): Promise<void>;
  start(): Promise<void>;
  cleanup(): Promise<void>;
  databaseFiles(): Promise<string[]>;
}

async function runFile(file: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  return execFileAsync(file, args, { ...options, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
}

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await runFile("git", args, { cwd: repo })).stdout;
}

async function write(root: string, path: string, contents: string): Promise<void> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function makeGitRepo(repo: string, changed: boolean): Promise<void> {
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Review harness");
  await git(repo, "config", "user.email", "harness@example.invalid");
  await write(
    repo,
    "package.json",
    JSON.stringify({ name: "review-harness", private: true, type: "module" }, null, 2) + "\n",
  );
  await write(
    repo,
    "tsconfig.json",
    JSON.stringify(
      {
        compilerOptions: { module: "esnext", moduleResolution: "bundler", strict: true },
        include: ["src"],
      },
      null,
      2,
    ) + "\n",
  );
  await write(
    repo,
    "src/pricing.ts",
    "export function total(price: number, quantity: number): number {\n  return price * quantity;\n}\n",
  );
  await write(
    repo,
    "src/orders.ts",
    'import { total } from "./pricing.js";\nexport function submitOrder(price: number): number {\n  return total(price, 1);\n}\n',
  );
  await write(
    repo,
    "src/orders.test.ts",
    'import { submitOrder } from "./orders.js";\nexport function testOrder(): boolean {\n  return submitOrder(10) === 10;\n}\n',
  );
  await git(repo, "add", ".");
  await git(
    repo,
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "initial order pricing",
  );
  if (!changed) return;
  await write(
    repo,
    "src/pricing.ts",
    "export function total(price: number, quantity: number): number {\n  const discount = quantity >= 10 ? 0.9 : 1;\n  return price * quantity * discount;\n}\n",
  );
  await write(
    repo,
    "src/orders.ts",
    'import { total } from "./pricing.js";\nexport function submitOrder(price: number, quantity: number): number {\n  return total(price, quantity);\n}\n',
  );
  await write(
    repo,
    "src/orders.test.ts",
    'import { submitOrder } from "./orders.js";\nexport function testOrder(): boolean {\n  return submitOrder(10, 10) === 90;\n}\n',
  );
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate a test port");
  await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
  return address.port;
}

async function walkFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root);
    const nested = await Promise.all(
      entries.map(async (name) => {
        const path = join(root, name);
        return (await stat(path)).isDirectory() ? walkFiles(path) : [path];
      }),
    );
    return nested.flat();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function createShippedReview(): Promise<ShippedReview> {
  await Promise.all([
    stat(shippedCli),
    stat(join(projectRoot, "plugin", "dist", "server.js")),
    stat(join(projectRoot, "plugin", "web", "index.html")),
  ]);
  const workspace = await mkdtemp(join(tmpdir(), "srev-shipped-e2e-"));
  const repo = join(workspace, "orders");
  const otherRepo = join(workspace, "other-repo");
  const dataDir = join(workspace, "state");
  await makeGitRepo(repo, true);
  await makeGitRepo(otherRepo, false);
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    GRAPH_PROVIDER: "scip",
    SCIP_REPO_ROOT: repo,
    SREV_DATA_DIR: dataDir,
    SREV_INDEXER_HOME: join(projectRoot, "packages", "server"),
    SREV_SERVER_URL: baseUrl,
  };

  const command = async <T>(cwd: string, args: string[]): Promise<T> => {
    const result = await runFile(process.execPath, [shippedCli, ...args, "--port", String(port)], { cwd, env });
    return JSON.parse(result.stdout) as T;
  };
  const review: ShippedReview = {
    workspace,
    repo,
    otherRepo,
    dataDir,
    port,
    baseUrl,
    env,
    srev: <T>(...args: string[]) => command<T>(repo, args),
    srevFrom: <T>(cwd: string, ...args: string[]) => command<T>(cwd, args),
    async srevFailure(...args: string[]) {
      try {
        await command(repo, args);
        throw new Error(`expected srev ${args.join(" ")} to fail`);
      } catch (error) {
        return error as CommandFailure;
      }
    },
    async stop() {
      try {
        await command(repo, ["shutdown"]);
      } catch {
        /* already stopped */
      }
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(300) });
        } catch {
          return;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      throw new Error("shipped review hub did not stop within 10 seconds");
    },
    async start() {
      await command(repo, ["serve", "--repo", repo]);
    },
    async cleanup() {
      await review.stop();
      await rm(workspace, { recursive: true, force: true });
    },
    async databaseFiles() {
      return (await walkFiles(dataDir)).filter((path) => path.endsWith(".db"));
    },
  };
  return review;
}
