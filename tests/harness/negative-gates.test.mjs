import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const ESLINT = join(REPOSITORY_ROOT, "node_modules/.bin/eslint");
const DEPCRUISE = join(REPOSITORY_ROOT, "node_modules/.bin/depcruise");

let fixtureRoot;

function write(relativePath, contents) {
  const path = join(fixtureRoot, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function run(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: fixtureRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function lint(relativePath) {
  const result = run(ESLINT, ["--format", "json", relativePath]);
  if (!result.stdout) throw new Error(result.stderr || "ESLint produced no JSON report");
  const reports = JSON.parse(result.stdout);
  const messages = reports.flatMap((report) => report.messages);
  return { ...result, messages };
}

function expectLintRules(relativePath, expectedRules) {
  const result = lint(relativePath);
  expect(result.status, result.stderr).not.toBe(0);
  expect(result.messages.map((message) => message.ruleId)).toEqual(expect.arrayContaining(expectedRules));
  return result.messages;
}

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "srev-negative-gates-"));
  symlinkSync(join(REPOSITORY_ROOT, "node_modules"), join(fixtureRoot, "node_modules"), "dir");
  copyFileSync(join(REPOSITORY_ROOT, "eslint.config.mjs"), join(fixtureRoot, "eslint.config.mjs"));
  copyFileSync(join(REPOSITORY_ROOT, ".dependency-cruiser.cjs"), join(fixtureRoot, ".dependency-cruiser.cjs"));
  copyFileSync(join(REPOSITORY_ROOT, "tsconfig.base.json"), join(fixtureRoot, "tsconfig.base.json"));
  write("packages/server/tsconfig.json", '{"extends":"../../tsconfig.base.json","include":["src"]}\n');
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("configured static gates reject production regressions", () => {
  it("rejects cyclomatic complexity above 15", () => {
    const branches = Array.from({ length: 16 }, (_, index) => `  if (flags[${index}]) total += ${index};`).join("\n");
    write(
      "packages/server/src/complex.ts",
      `export function complex(flags: boolean[]): number {\n  let total = 0;\n${branches}\n  return total;\n}\n`,
    );

    const messages = expectLintRules("packages/server/src/complex.ts", ["complexity"]);
    expect(messages.find((message) => message.ruleId === "complexity")?.message).toMatch(
      /complexity of 17.*maximum allowed is 15/i,
    );
  });

  it("counts executable function lines while excluding comments", () => {
    const comments = Array.from({ length: 100 }, (_, index) => `  // explanation ${index}`).join("\n");
    const statements = Array.from({ length: 81 }, () => "  total += 1;").join("\n");
    write(
      "packages/server/src/function-length.ts",
      `export function commentsDoNotCount(): number {\n${comments}\n  return 1;\n}\n\nexport function tooLong(): number {\n  let total = 0;\n${statements}\n  return total;\n}\n`,
    );

    const messages = expectLintRules("packages/server/src/function-length.ts", ["max-lines-per-function"]);
    const lengthMessages = messages.filter((message) => message.ruleId === "max-lines-per-function");
    expect(lengthMessages).toHaveLength(1);
    expect(lengthMessages[0].message).toMatch(/maximum allowed is 80/i);
  });

  it("enforces production helper parameter and nesting limits", () => {
    write(
      "packages/server/src/helper-limits.ts",
      `export function tooManyParameters(a: number, b: number, c: number, d: number, e: number, f: number): number {\n  return a + b + c + d + e + f;\n}\n\nexport function tooDeep(flags: boolean[]): number {\n  if (flags[0]) {\n    if (flags[1]) {\n      if (flags[2]) {\n        if (flags[3]) {\n          if (flags[4]) return 1;\n        }\n      }\n    }\n  }\n  return 0;\n}\n`,
    );

    expectLintRules("packages/server/src/helper-limits.ts", ["max-params", "max-depth"]);
  });

  it("uses typed linting to reject a floating promise", () => {
    write(
      "packages/server/src/floating.ts",
      `async function persist(): Promise<void> {}\nexport function launch(): void {\n  persist();\n}\n`,
    );

    expectLintRules("packages/server/src/floating.ts", ["@typescript-eslint/no-floating-promises"]);
  });
});

describe("configured dependency boundaries reject forbidden imports", () => {
  it("rejects web source importing server internals", () => {
    write("packages/server/src/private.ts", "export const privateValue = 1;\n");
    write(
      "packages/web/src/bad.ts",
      'import { privateValue } from "../../server/src/private.js";\nexport { privateValue };\n',
    );

    const result = run(DEPCRUISE, ["--config", ".dependency-cruiser.cjs", "--output-type", "err", "packages/web/src"]);
    expect(result.status, `${result.stderr}\n${result.stdout}`).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("web-uses-api-only");
  });
});
