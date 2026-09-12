import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { runCoverage, changedCoverage } from "../../scripts/harness/coverage-run.mjs";

const dirs = [];
function fixture(hits = 1) {
  const root = mkdtempSync(join(tmpdir(), "harness-coverage-"));
  dirs.push(root);
  for (const d of ["packages/server/src", "packages/skill/src", "packages/web/src", "scripts", "coverage", ".harness"])
    mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "packages/server/src/a.ts"), "export const a = 1;\n");
  writeFileSync(
    join(root, "coverage/coverage-final.json"),
    JSON.stringify({
      [join(root, "packages/server/src/a.ts")]: {
        statementMap: { 0: { start: { line: 1 }, end: { line: 1 } } },
        s: { 0: hits },
        fnMap: { 0: {} },
        branchMap: { 0: { locations: [{}] } },
        f: { 0: hits },
        b: { 0: [hits] },
      },
    }),
  );
  writeFileSync(join(root, ".harness/coverage-baseline.json"), JSON.stringify({ files: {} }));
  return root;
}
afterEach(() => {
  for (const root of dirs.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("coverage command", () => {
  it("checks actual reports and maintained files, including unimported sources", () => {
    const root = fixture();
    expect(runCoverage({ root, strict: true }).failures).toEqual([]);
    writeFileSync(join(root, "scripts/unimported.mjs"), "export const missed = 1;\n");
    writeFileSync(join(root, "packages/server/src/types.d.ts"), "declare const type: string;");
    writeFileSync(join(root, "packages/web/src/styles.css"), "not code");
    expect(runCoverage({ root }).failures).toContain("scripts/unimported.mjs: missing from coverage report");
  });
  it("fails when a report, baseline or base revision is missing", () => {
    const root = fixture();
    expect(() => runCoverage({ root, changed: true, baseRef: "missing" })).toThrow();
    for (const policy of [{}, { files: [] }, { files: "invalid" }]) {
      writeFileSync(join(root, ".harness/coverage-baseline.json"), JSON.stringify(policy));
      expect(() => runCoverage({ root })).toThrow(/baseline files/);
    }
    rmSync(join(root, ".harness/coverage-baseline.json"));
    expect(() => runCoverage({ root })).toThrow();
    expect(runCoverage({ root, strict: true }).failures).toEqual([]);
    rmSync(join(root, "coverage/coverage-final.json"));
    expect(() => runCoverage({ root, strict: true })).toThrow();
  });
  it("rejects an uncovered change and counts untracked source against a real merge base", () => {
    const root = fixture(0);
    const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-b", "main");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Fixture");
    git("add", ".");
    git("commit", "-m", "base");
    expect(runCoverage({ root, changed: true, baseRef: "main" }).changed.percent).toBe(100);
    writeFileSync(join(root, "packages/server/src/a.ts"), "export const a = 2;\n");
    const result = runCoverage({ root, changed: true, baseRef: "main" });
    expect(result.changed.percent).toBe(0);
    expect(result.failures.join(" ")).toMatch(/changed executable lines/);
    git("rm", "--cached", "packages/server/src/a.ts");
    expect(runCoverage({ root, changed: true, baseRef: "main" }).changed.total).toBe(1);
  });
});

describe("setup migration exceptions", () => {
  it("limits setup exceptions to an exact file fingerprint and base; strict always checks the change", () => {
    const root = fixture(0);
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-b", "main");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Fixture");
    git("add", ".");
    git("commit", "-m", "base");
    const source = "packages/server/src/a.ts";
    const contents = "export const a = 2;\n";
    writeFileSync(join(root, source), contents);
    const policy = {
      files: { [source]: { lines: 0, statements: 0, functions: 0, branches: 0 } },
      bootstrapChanges: {
        base: git("rev-parse", "HEAD"),
        files: {
          [source]: createHash("sha256").update(contents).digest("hex"),
        },
      },
    };
    writeFileSync(join(root, ".harness/coverage-baseline.json"), JSON.stringify(policy));
    expect(() => runCoverage({ root, changed: true })).toThrow(/unapproved setup exception/);
    policy.bootstrapChanges.base = "cb5ca28c0fe0824dfe8b400d99d0ebb1fa003101";
    writeFileSync(join(root, ".harness/coverage-baseline.json"), JSON.stringify(policy));
    expect(() => runCoverage({ root, changed: true })).toThrow(/unapproved setup exception/);
    policy.bootstrapChanges.base = git("rev-parse", "HEAD");
    const report = {
      [source]: {
        statementMap: { 0: { start: { line: 1 } } },
        fnMap: { 0: {} },
        branchMap: { 0: { locations: [{}] } },
        s: { 0: 0 },
        f: { 0: 0 },
        b: { 0: [0] },
      },
    };
    const evaluate = () => changedCoverage(root, report, [source], "main", policy.bootstrapChanges);
    const result = evaluate();
    expect(result.percent).toBe(100);
    expect(result.rawPercent).toBe(0);
    expect(result.exempted).toEqual([source]);
    expect(runCoverage({ root, strict: true, changed: true }).changed.percent).toBe(0);
    writeFileSync(join(root, source), "export const a = 3;\n");
    expect(evaluate().percent).toBe(0);
    writeFileSync(join(root, source), contents);
    policy.bootstrapChanges.base = "different-base";
    writeFileSync(join(root, ".harness/coverage-baseline.json"), JSON.stringify(policy));
    expect(evaluate().percent).toBe(0);
  });
});

describe("source-bound branch debt policy", () => {
  it("rejects the retired manifest for changed source and rejects altered debt", () => {
    const root = fixture();
    const repo = new URL("../../", import.meta.url);
    const source = "packages/server/src/graph/scip.ts";
    const contents = readFileSync(new URL(source, repo), "utf8");
    const branchDebt = JSON.parse(
      readFileSync(new URL("fixtures/retired-scip-branch-debt.json", import.meta.url), "utf8"),
    );
    const policy = { files: {}, branchDebt };
    const save = () => writeFileSync(join(root, ".harness/coverage-baseline.json"), JSON.stringify(policy));
    mkdirSync(join(root, "packages/server/src/graph"));
    writeFileSync(join(root, source), contents);
    save();
    expect(() => runCoverage({ root })).toThrow(/branch debt source changed/);
    writeFileSync(join(root, source), contents + "\n// changed source\n");
    expect(() => runCoverage({ root })).toThrow(/branch debt source changed/);
    writeFileSync(join(root, source), contents);
    policy.branchDebt[source].uncovered.push("new exemption");
    save();
    expect(() => runCoverage({ root })).toThrow(/unapproved branch debt/);
    policy.branchDebt[source].uncovered.pop();
    policy.branchDebt["packages/server/src/a.ts"] = { sourceHash: "anything", uncovered: [] };
    save();
    expect(() => runCoverage({ root })).toThrow(/unapproved branch debt/);
  });
});
