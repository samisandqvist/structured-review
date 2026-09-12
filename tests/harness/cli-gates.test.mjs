import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { checkCoverageCli, checkCoverageMain } from "../../scripts/harness/check-coverage.mjs";
import { checkStaticCli, checkStaticMain } from "../../scripts/harness/check-static.mjs";
import { buildPluginArtifacts, checkArtifactsCli, checkArtifactsMain } from "../../scripts/harness/check-artifacts.mjs";
import { spawnCommand, verificationNames, verifyCli, verifyMain } from "../../scripts/harness/verify.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const originalExitCode = process.exitCode;

const dirs = [];
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function coverageFixture() {
  const root = mkdtempSync(join(tmpdir(), "crw-cli-coverage-"));
  dirs.push(root);
  for (const path of [
    "packages/server/src",
    "packages/skill/src",
    "packages/web/src",
    "scripts",
    "coverage",
    ".harness",
  ])
    mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, "packages/server/src/a.ts"), "export const a = 1;\n");
  writeFileSync(
    join(root, "coverage/coverage-final.json"),
    JSON.stringify({
      [join(root, "packages/server/src/a.ts")]: {
        statementMap: { 0: { start: { line: 1 }, end: { line: 1 } } },
        fnMap: { 0: {} },
        branchMap: { 0: { locations: [{}] } },
        s: { 0: 1 },
        f: { 0: 1 },
        b: { 0: [1] },
      },
    }),
  );
  writeFileSync(join(root, ".harness/coverage-baseline.json"), JSON.stringify({ files: {} }));
  return root;
}

function staticFixture() {
  const root = mkdtempSync(join(tmpdir(), "crw-cli-static-real-"));
  dirs.push(root);
  symlinkSync(join(repositoryRoot, "node_modules"), join(root, "node_modules"), "dir");
  for (const file of ["eslint.config.mjs", "knip.json", "tsconfig.base.json"])
    copyFileSync(join(repositoryRoot, file), join(root, file));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      private: true,
      type: "module",
      scripts: { lint: "eslint .", knip: "knip" },
      devDependencies: {
        "@eslint/js": "9.39.1",
        eslint: "9.39.1",
        "eslint-plugin-sonarjs": "4.2.0",
        globals: "16.5.0",
        knip: "6.35.1",
        "typescript-eslint": "8.70.0",
      },
    }),
  );
  mkdirSync(join(root, ".harness"), { recursive: true });
  writeFileSync(join(root, ".harness/static-baseline.json"), JSON.stringify({ lint: {}, unused: {} }));
  for (const [workspace, entry] of [
    ["server", "index.ts"],
    ["skill", "cli.ts"],
    ["web", "main.tsx"],
  ]) {
    const workspaceRoot = join(root, "packages", workspace);
    mkdirSync(join(workspaceRoot, "src"), { recursive: true });
    writeFileSync(join(workspaceRoot, "src", entry), "export {};\n");
    writeFileSync(
      join(workspaceRoot, "tsconfig.json"),
      JSON.stringify({ extends: "../../tsconfig.base.json", include: ["src"] }),
    );
  }
  return root;
}

describe("coverage CLI gate", () => {
  it("runs the real coverage command logic and fails closed on missing inputs", () => {
    const root = coverageFixture();
    const log = vi.fn();
    expect(checkCoverageMain({ root, args: [], env: {}, log })).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"mode": "transitional"'));

    rmSync(join(root, ".harness/coverage-baseline.json"));
    expect(() => checkCoverageMain({ root, args: [], env: {}, log })).toThrow();
    expect(checkCoverageMain({ root, args: ["--strict"], env: {}, log })).toBe(0);
    const reportPath = join(root, "coverage/coverage-final.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const fileCoverage = Object.values(report)[0];
    fileCoverage.s[0] = 0;
    fileCoverage.f[0] = 0;
    fileCoverage.b[0] = [0];
    writeFileSync(reportPath, JSON.stringify(report));
    expect(checkCoverageMain({ root, args: ["--strict"], env: { HARNESS_BASE: "custom-base" }, log })).toBe(1);
    rmSync(join(root, "coverage/coverage-final.json"));
    expect(() => checkCoverageMain({ root, args: ["--strict"], env: {}, log })).toThrow();
  });
});

describe("static CLI gate", () => {
  it("runs the configured ESLint and Knip integrations and writes their report", { timeout: 30_000 }, async () => {
    const root = staticFixture();
    const log = vi.fn();
    const error = vi.fn();
    const code = await checkStaticMain({ root, args: [], log, error });
    if (code !== 0) throw new Error(JSON.stringify(error.mock.calls));
    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^TRANSITIONAL static:/));
    expect(error).not.toHaveBeenCalled();
  });

  it("fails closed without a baseline and propagates strict findings", async () => {
    const root = mkdtempSync(join(tmpdir(), "crw-cli-static-"));
    dirs.push(root);
    const collect = vi.fn(async () => ({ lint: ["a.ts|rule|bad|line"], unused: [] }));
    await expect(checkStaticMain({ root, args: [], collect })).rejects.toThrow(/baseline|ENOENT/);
    expect(collect).not.toHaveBeenCalled();

    mkdirSync(join(root, ".harness"), { recursive: true });
    writeFileSync(join(root, ".harness/static-baseline.json"), JSON.stringify({ lint: {}, unused: {} }));
    expect(await checkStaticMain({ root, args: ["--strict"], collect, log: vi.fn(), error: vi.fn() })).toBe(1);
  });
});

describe("artifact CLI gate", () => {
  it("runs the real shipped-artifact generator in an isolated output directory", { timeout: 30_000 }, () => {
    const log = vi.fn();
    expect(checkArtifactsMain({ root: repositoryRoot, log, error: vi.fn() })).toBe(0);
    expect(log).toHaveBeenCalledWith("Plugin freshness: PASS");
  });

  it("reports a generated artifact mismatch and fails closed on missing shipped inputs", { timeout: 30_000 }, () => {
    const error = vi.fn();
    const build = (root, output) => {
      buildPluginArtifacts(root, output);
      writeFileSync(join(output, "plugin/LICENSE"), "changed during test\n");
    };
    expect(checkArtifactsMain({ root: repositoryRoot, build, log: vi.fn(), error })).toBe(1);
    expect(error).toHaveBeenCalledWith("plugin/LICENSE");

    const missingRoot = mkdtempSync(join(tmpdir(), "crw-cli-artifact-missing-"));
    dirs.push(missingRoot);
    expect(() => checkArtifactsMain({ root: missingRoot, log: vi.fn(), error })).toThrow();
  });
});

describe("verify CLI gate", () => {
  const standardNames = [
    "typecheck",
    "format:check",
    "lint",
    "architecture",
    "test:coverage",
    "coverage:check",
    "build",
    "plugin:check",
    "test:e2e",
    "security:check",
    "security:probe",
  ];

  it("keeps the required transitional, strict, and full check lists exact", () => {
    expect(verificationNames({ strict: false, full: false })).toEqual(standardNames);
    expect(verificationNames({ strict: true, full: false })).toEqual(
      standardNames.map((name) => ({ lint: "lint:strict", "coverage:check": "coverage:strict" })[name] ?? name),
    );
    expect(verificationNames({ strict: false, full: true })).toEqual([...standardNames, "test:mutation"]);
  });

  it("runs every required check, propagates failure, and writes an auditable report", async () => {
    const root = mkdtempSync(join(tmpdir(), "crw-cli-verify-"));
    dirs.push(root);
    const commands = [];
    const execute = vi.fn(async (command) => {
      commands.push(command);
      return command.at(-1) === "security:probe" ? 2 : 0;
    });
    const table = vi.fn();
    expect(await verifyMain({ root, args: ["--strict", "--full"], execute, log: vi.fn(), table })).toBe(1);
    expect(commands).toEqual(verificationNames({ strict: true, full: true }).map((name) => ["pnpm", "run", name]));
    expect(table).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(join(root, "reports/verify-strict.json"), "utf8"))).toMatchObject({
      ok: false,
      policy: "strict",
      mutationIncluded: true,
    });
  });

  it("returns success and the subprocess adapter preserves success and failure exits", async () => {
    const root = mkdtempSync(join(tmpdir(), "crw-cli-verify-success-"));
    dirs.push(root);
    expect(await verifyMain({ root, args: [], execute: async () => 0, log: vi.fn(), table: vi.fn() })).toBe(0);
    expect(await spawnCommand([process.execPath, "-e", "process.exit(0)"], vi.fn())).toBe(0);
    expect(await spawnCommand([process.execPath, "-e", "process.exit(3)"], vi.fn())).toBe(3);
    expect(await spawnCommand([join(root, "missing-command")], vi.fn())).toBe(1);
  });
});

describe("direct CLI adapters", () => {
  for (const [name, entry] of [
    ["coverage", checkCoverageCli],
    ["static", checkStaticCli],
    ["artifacts", checkArtifactsCli],
    ["verify", verifyCli],
  ]) {
    it(`runs ${name} only when its module is the direct entry point`, async () => {
      const main = vi.fn(() => 7);
      expect(await entry({ metaUrl: "file:///tmp/gate.mjs", argv: [], main })).toBeUndefined();
      expect(
        await entry({ metaUrl: "file:///tmp/gate.mjs", argv: [process.execPath, "/tmp/other.mjs"], main }),
      ).toBeUndefined();
      expect(
        await entry({
          metaUrl: "file:///tmp/gate.mjs",
          argv: [process.execPath, "/tmp/gate.mjs", "--strict"],
          root: "/tmp/root",
          main,
        }),
      ).toBe(7);
      expect(main).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(7);
    });
  }
});
