import fs from "node:fs";
import { pathToFileURL } from "node:url";

export function summarizeGitleaks(report) {
  if (!Array.isArray(report)) throw new TypeError("Gitleaks report must be an array");
  return report.map((finding) => ({
    ruleId: stringOr(finding.RuleID, "unknown-rule"),
    file: stringOr(finding.File, "unknown-file"),
    line: positiveIntegerOr(finding.StartLine, "?"),
  }));
}

export function assessOsvReport(report, threshold = 7) {
  if (!report || !Array.isArray(report.results)) throw new TypeError("OSV report is missing results");
  if (!Number.isFinite(threshold)) throw new TypeError("severity threshold must be numeric");

  const findings = report.results.flatMap((result) => parseOsvResult(result, threshold));

  return {
    findings,
    blocking: findings.filter((finding) => finding.blocking),
    lowerSeverity: findings.filter((finding) => !finding.blocking),
  };
}

export function advisoryFreshness(updatedAtText, maxAgeSeconds, now = Date.now()) {
  const updatedAt = Date.parse(updatedAtText.trim());
  const maxAgeMs = Number(maxAgeSeconds) * 1000;
  if (!Number.isFinite(updatedAt) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0 || !Number.isFinite(now)) {
    return "invalid";
  }
  if (updatedAt > now) return "invalid";
  return now - updatedAt > maxAgeMs ? "stale" : "fresh";
}

function parseOsvResult(result, threshold) {
  if (!result || !Array.isArray(result.packages)) throw new TypeError("OSV result is missing packages");
  return result.packages.flatMap((pkg) => parseOsvPackage(pkg, threshold));
}

function parseOsvPackage(pkg, threshold) {
  if (!pkg || !Array.isArray(pkg.groups)) throw new TypeError("OSV package is missing groups");
  return pkg.groups.map((group) => parseOsvGroup(pkg, group, threshold));
}

function parseOsvGroup(pkg, group, threshold) {
  if (!group || !Array.isArray(group.ids)) throw new TypeError("OSV vulnerability group is missing ids");
  const severity = numericSeverity(group.max_severity);
  return {
    ids: group.ids.filter((id) => typeof id === "string"),
    severity,
    name: stringOr(pkg.package?.name, "unknown-package"),
    version: stringOr(pkg.package?.version, "unknown-version"),
    blocking: severity === null || severity >= threshold,
  };
}

function numericSeverity(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && value.trim().length === 0) return null;
  const severity = Number(value);
  return Number.isFinite(severity) && severity >= 0 && severity <= 10 ? severity : null;
}

function positiveIntegerOr(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function loadJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function runGitleaks(path, _option, output) {
  if (!path) return 2;
  const findings = summarizeGitleaks(loadJson(path));
  if (findings.length === 0) {
    output.log("secret scan: no findings");
    return 0;
  }
  output.error(`secret scan: ${findings.length} finding(s)`);
  for (const finding of findings) output.error(`- ${finding.ruleId} at ${finding.file}:${finding.line}`);
  return 1;
}

function runOsv(path, option, output) {
  if (!path) return 2;
  const assessment = assessOsvReport(loadJson(path), option === undefined ? 7 : Number(option));
  if (assessment.findings.length === 0) {
    output.log("dependency scan: no known vulnerabilities");
    return 0;
  }
  if (assessment.blocking.length === 0) return printLowerSeverityOsvResult(assessment, output);
  return printBlockingOsvResult(assessment, output);
}

function printLowerSeverityOsvResult(assessment, output) {
  output.log(
    `dependency scan: no high/critical findings; ${assessment.lowerSeverity.length} lower-severity advisory group(s) reported by OSV`,
  );
  return 0;
}

function printBlockingOsvResult(assessment, output) {
  output.error(
    `dependency scan: ${assessment.blocking.length} high/critical or unknown-severity group(s) block; ${assessment.lowerSeverity.length} lower-severity group(s) do not block`,
  );
  for (const finding of assessment.blocking) {
    const severity = finding.severity === null ? "unknown" : finding.severity.toFixed(1);
    output.error(
      `- ${finding.name}@${finding.version}: ${finding.ids.join(", ") || "unknown-advisory"} (CVSS ${severity})`,
    );
  }
  return 1;
}

function runFreshness(path, option) {
  if (!path || option === undefined) return 2;
  const freshness = advisoryFreshness(fs.readFileSync(path, "utf8"), option);
  if (freshness === "fresh") return 0;
  return freshness === "stale" ? 3 : 2;
}

const CLI_HANDLERS = new Map([
  ["gitleaks", runGitleaks],
  ["osv", runOsv],
  ["freshness", runFreshness],
]);

export function runCli(args, output = console) {
  const [command, path, option] = args;
  const handler = CLI_HANDLERS.get(command);
  if (handler) return handler(path, option, output);
  output.error("usage: report.mjs <gitleaks|osv|freshness> <report-or-timestamp> [threshold-or-max-age-seconds]");
  return 2;
}

export function main(args, output = console) {
  try {
    return runCli(args, output);
  } catch (error) {
    output.error(`security report failed: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
