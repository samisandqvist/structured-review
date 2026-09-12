export const targets = { lines: 95, statements: 95, functions: 95, branches: 90 };
const percentage = (values) => (values.length ? (100 * values.filter((n) => n > 0).length) / values.length : 100);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validateCoverage(file) {
  if (!file || ![file.statementMap, file.fnMap, file.branchMap, file.s, file.f, file.b].every(object))
    throw new Error("missing or invalid file coverage");
  const counts = [...Object.values(file.s), ...Object.values(file.f), ...Object.values(file.b).flat()];
  if (counts.some((value) => !Number.isInteger(value) || value < 0) || !Object.values(file.b).every(Array.isArray))
    throw new Error("invalid coverage counts");
  for (const [map, hits] of [
    [file.statementMap, file.s],
    [file.fnMap, file.f],
    [file.branchMap, file.b],
  ]) {
    if (Object.keys(map).length !== Object.keys(hits).length || Object.keys(map).some((id) => !Object.hasOwn(hits, id)))
      throw new Error("incomplete coverage counters");
  }
  for (const [id, branch] of Object.entries(file.branchMap)) {
    if (!Array.isArray(branch?.locations) || branch.locations.length !== file.b[id].length)
      throw new Error("incomplete coverage branch outcomes");
  }
}
function requiredMetrics(baseline) {
  if (baseline === undefined) return targets;
  if (
    !object(baseline) ||
    Object.keys(baseline).length !== 4 ||
    Object.keys(targets).some((key) => !Number.isFinite(baseline[key]) || baseline[key] < 0 || baseline[key] > 100)
  )
    throw new Error("invalid coverage baseline");
  return baseline;
}
export function executableLines(file) {
  validateCoverage(file);
  const lines = new Map();
  for (const [id, statement] of Object.entries(file.statementMap)) {
    const line = statement?.start?.line;
    if (!Number.isInteger(line) || line < 1 || !Object.hasOwn(file.s, id))
      throw new Error("invalid coverage statement location or count");
    lines.set(line, Math.max(lines.get(line) ?? 0, file.s[id] ?? 0));
  }
  return lines;
}

export function metrics(file) {
  return {
    lines: percentage([...executableLines(file).values()]),
    statements: percentage(Object.values(file.s)),
    functions: percentage(Object.values(file.f)),
    branches: percentage(Object.values(file.b).flat()),
  };
}

function validPoint(point) {
  return point && Number.isInteger(point.line) && point.line > 0 && Number.isInteger(point.column) && point.column >= 0;
}
function branchSignature(branch, index) {
  const location = branch.locations[index];
  if (typeof branch.type !== "string" || !validPoint(location?.start) || !validPoint(location?.end))
    throw new Error("invalid coverage branch location");
  return `${branch.type}|${location.start.line}:${location.start.column}-${location.end.line}:${location.end.column}|${index}`;
}
export function uncoveredBranches(file) {
  validateCoverage(file);
  return Object.entries(file.b)
    .flatMap(([id, hits]) =>
      hits.flatMap((hit, index) => (hit === 0 ? [branchSignature(file.branchMap[id], index)] : [])),
    )
    .sort();
}
function newUncoveredBranches(file, debt) {
  if (!Array.isArray(debt) || debt.some((signature) => typeof signature !== "string"))
    throw new Error("invalid coverage branch debt");
  const remaining = new Map();
  for (const signature of debt) remaining.set(signature, (remaining.get(signature) ?? 0) + 1);
  return uncoveredBranches(file).filter((signature) => {
    const count = remaining.get(signature) ?? 0;
    if (count === 0) return true;
    remaining.set(signature, count - 1);
    return false;
  });
}
export function assessCoverage(report, sources, baseline, branchDebt) {
  if (!report || !Object.keys(report).length) throw new Error("missing or empty coverage report");
  const failures = [];
  for (const source of sources) {
    if (!report[source]) {
      failures.push(`${source}: missing from coverage report`);
      continue;
    }
    const actual = metrics(report[source]);
    const required = requiredMetrics(baseline?.[source]);
    for (const [metric, threshold] of Object.entries(required)) {
      if (metric === "branches" && branchDebt?.[source] !== undefined) {
        failures.push(
          ...newUncoveredBranches(report[source], branchDebt[source]).map(
            (signature) => `${source}: new uncovered branch ${signature}`,
          ),
        );
        continue;
      }
      if (actual[metric] + 1e-8 < threshold) failures.push(`${source}: ${metric} ${actual[metric]} < ${threshold}`);
    }
  }
  return failures;
}

export function changedLines(patch) {
  const lines = new Set();
  for (const line of patch.split("\n").filter((s) => s.startsWith("@@"))) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) throw new Error("invalid diff hunk");
    const start = Number(match[1]);
    const count = Number(match[2] ?? 1);
    for (let offset = 0; offset < count; offset++) lines.add(start + offset);
  }
  return [...lines];
}

export function changedExecutableCoverage(file, changed) {
  const lines = executableLines(file);
  const hits = [...new Set(changed)].filter((line) => lines.has(line)).map((line) => lines.get(line));
  return { covered: hits.filter((n) => n > 0).length, total: hits.length, percent: percentage(hits) };
}
