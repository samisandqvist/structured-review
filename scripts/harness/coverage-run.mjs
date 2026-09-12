import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { assessCoverage, changedLines, changedExecutableCoverage } from "./coverage.mjs";
import { maintainedSources } from "./scope.mjs";

// Approved initial migration only. Editing baseline JSON cannot mint new exemptions.
const BOOTSTRAP_REVISION = "cb5ca28c0fe0824dfe8b400d99d0ebb1fa003101";
const BOOTSTRAP_MANIFEST_SHA256 = "0ed96f994d90ed2090b962787aa7ec575918c7b268ff7c0b12161d21f139f299";
function validateBootstrap(bootstrap) {
  if (bootstrap === undefined) return;
  const digest = createHash("sha256").update(JSON.stringify(bootstrap)).digest("hex");
  if (bootstrap?.base !== BOOTSTRAP_REVISION || digest !== BOOTSTRAP_MANIFEST_SHA256)
    throw new Error("unapproved setup exception manifest; the initial migration is immutable");
}
const BRANCH_DEBT_SHA256 = "1bceb03442281b42af55a727c5bc996000d27e7d8b6bd3e643d5804a91d94199";
function validatedBranchDebt(root, debt) {
  if (debt === undefined) return undefined;
  const digest = createHash("sha256").update(JSON.stringify(debt)).digest("hex");
  if (digest !== BRANCH_DEBT_SHA256) throw new Error("unapproved branch debt manifest");
  return Object.fromEntries(
    Object.entries(debt).map(([source, entry]) => {
      const hash = createHash("sha256")
        .update(readFileSync(join(root, source)))
        .digest("hex");
      if (hash !== entry.sourceHash) throw new Error("branch debt source changed; reassess the scoped exception");
      return [source, entry.uncovered];
    }),
  );
}
const readJson = (root, file) => JSON.parse(readFileSync(join(root, file), "utf8"));
const gitAt = (root, ...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function setupException(root, source, base, bootstrap) {
  if (bootstrap?.base !== base || !bootstrap.files?.[source]) return false;
  if (!gitAt(root, "ls-tree", "--name-only", base, "--", source)) return false;
  return (
    createHash("sha256")
      .update(readFileSync(join(root, source)))
      .digest("hex") === bootstrap.files[source]
  );
}

export function changedCoverage(root, report, sources, baseRef, bootstrap) {
  const base = gitAt(root, "merge-base", baseRef, "HEAD");
  if (!base) throw new Error("missing merge base");
  let covered = 0;
  let total = 0;
  let rawCovered = 0;
  let rawTotal = 0;
  const exempted = [];
  for (const source of sources) {
    const tracked = gitAt(root, "ls-files", "--", source);
    const lines = tracked
      ? changedLines(gitAt(root, "diff", "--no-ext-diff", "--no-renames", "--unified=0", base, "--", source))
      : [...Array(readFileSync(join(root, source), "utf8").split("\n").length)].map((_, i) => i + 1);
    const result = changedExecutableCoverage(report[source], lines);
    rawCovered += result.covered;
    rawTotal += result.total;
    if (result.total && setupException(root, source, base, bootstrap)) {
      exempted.push(source);
      continue;
    }
    covered += result.covered;
    total += result.total;
  }
  return {
    base,
    covered,
    total,
    percent: total ? (100 * covered) / total : 100,
    rawCovered,
    rawTotal,
    rawPercent: rawTotal ? (100 * rawCovered) / rawTotal : 100,
    exempted,
  };
}

function readCoveragePolicy(root, strict) {
  if (strict) return undefined;
  const policy = readJson(root, ".harness/coverage-baseline.json");
  if (!policy.files || typeof policy.files !== "object" || Array.isArray(policy.files))
    throw new Error("missing coverage baseline files");
  validateBootstrap(policy.bootstrapChanges);
  return policy;
}

export function runCoverage({ root, strict = false, changed = false, baseRef = "main" }) {
  const policy = readCoveragePolicy(root, strict);
  const baseline = policy?.files;
  const report = Object.fromEntries(
    Object.entries(readJson(root, "coverage/coverage-final.json")).map(([path, value]) => [
      relative(root, path).replaceAll("\\", "/"),
      value,
    ]),
  );
  const sources = maintainedSources(root);
  const failures = assessCoverage(report, sources, baseline, validatedBranchDebt(root, policy?.branchDebt));
  const result = { mode: strict ? "strict" : "transitional", sources: sources.length, failures };
  if (changed) {
    result.changed = changedCoverage(root, report, sources, baseRef, policy?.bootstrapChanges);
    if (result.changed.percent < 95)
      failures.push(`changed executable lines ${result.changed.percent.toFixed(2)} < 95`);
  }
  return result;
}
