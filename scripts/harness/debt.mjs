import { relative } from "node:path";

export function newFindings(findings, baseline) {
  if (!Array.isArray(findings) || findings.some((finding) => typeof finding !== "string")) {
    throw new Error("invalid debt findings");
  }
  if (!isPlainObject(baseline)) throw new Error("missing debt baseline");
  for (const count of Object.values(baseline)) {
    if (!Number.isInteger(count) || count < 0) throw new Error("invalid debt baseline count");
  }
  const remaining = { ...baseline };
  return findings.filter((finding) => {
    if ((remaining[finding] ?? 0) <= 0) return true;
    remaining[finding]--;
    return false;
  });
}
export function lintFindings(results, root) {
  return results.flatMap((result) =>
    result.messages.map((message) => {
      const line = result.source?.split("\n")[(message.line ?? 1) - 1]?.trim() ?? "";
      return `${relative(root, result.filePath).replaceAll("\\", "/")}|${message.ruleId ?? "fatal"}|${message.message}|${line}`;
    }),
  );
}
export function knipFindings(report) {
  if (!isPlainObject(report) || !Array.isArray(report.issues)) throw new Error("invalid unused-code report");
  if (report.files !== undefined && !Array.isArray(report.files)) throw new Error("invalid unused-code files");
  const findings = new Set((report.files ?? []).map((entry) => unusedFileFinding(entry)));
  for (const issue of report.issues) addKnipIssue(findings, issue);
  return [...findings];
}

function addKnipIssue(findings, issue) {
  if (!isPlainObject(issue) || typeof issue.file !== "string" || issue.file.length === 0) {
    throw new Error("invalid unused-code issue");
  }
  for (const [kind, entries] of Object.entries(issue)) {
    if (kind === "file") continue;
    if (!Array.isArray(entries)) throw new Error("invalid unused-code entries");
    for (const entry of entries) findings.add(`${issue.file}|${kind}|${entryName(entry)}`);
  }
}

function unusedFileFinding(entry) {
  const name = entryName(entry);
  return `${name}|files|${name}`;
}

function entryName(entry) {
  const name = typeof entry === "string" ? entry : isPlainObject(entry) ? entry.name : undefined;
  if (typeof name !== "string" || name.length === 0) throw new Error("invalid unused-code entry");
  return name;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
