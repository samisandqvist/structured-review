import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { advisoryFreshness, assessOsvReport, main, runCli, summarizeGitleaks } from "../../scripts/security/report.mjs";

let fixtureDir;

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "srev-security-report-"));
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function fixture(name, value, raw = false) {
  const path = join(fixtureDir, name);
  writeFileSync(path, raw ? value : JSON.stringify(value));
  return path;
}

function outputCapture() {
  const logs = [];
  const errors = [];
  return { logs, errors, output: { log: (message) => logs.push(message), error: (message) => errors.push(message) } };
}

describe("security report parsing", () => {
  it("summarizes Gitleaks findings without retaining secret-bearing fields", () => {
    const summary = summarizeGitleaks([
      {
        RuleID: "generic-api-key",
        File: "fixture.ts",
        StartLine: 4,
        Secret: "must-not-survive",
        Match: "must-not-survive",
      },
    ]);

    expect(summary).toEqual([{ ruleId: "generic-api-key", file: "fixture.ts", line: 4 }]);
    expect(JSON.stringify(summary)).not.toContain("must-not-survive");
    expect(summarizeGitleaks([{ RuleID: "", File: null, StartLine: 0 }])).toEqual([
      { ruleId: "unknown-rule", file: "unknown-file", line: "?" },
    ]);
    expect(() => summarizeGitleaks({})).toThrow("must be an array");
  });

  it("blocks CVSS high and unknown severities while retaining lower findings", () => {
    const assessment = assessOsvReport({
      results: [
        {
          packages: [
            {
              package: { name: "high-package", version: "1.0.0" },
              groups: [{ ids: ["GHSA-high"], max_severity: "7.5" }],
            },
            {
              package: { name: "moderate-package", version: "2.0.0" },
              groups: [{ ids: ["GHSA-moderate"], max_severity: "6.9" }],
            },
            {
              package: { name: "unknown-package", version: "3.0.0" },
              groups: [{ ids: ["GHSA-unknown"] }],
            },
          ],
        },
      ],
    });

    expect(assessment.blocking.map(({ name }) => name)).toEqual(["high-package", "unknown-package"]);
    expect(assessment.lowerSeverity.map(({ name }) => name)).toEqual(["moderate-package"]);
    expect(() => assessOsvReport({ results: [] }, Number.NaN)).toThrow("threshold must be numeric");
  });

  it.each(["", "   ", -1, 11, "Infinity", null])("blocks malformed CVSS severity %j as unknown", (severity) => {
    const assessment = assessOsvReport({
      results: [
        {
          packages: [
            {
              package: { name: "malformed", version: "1.0.0" },
              groups: [{ ids: ["GHSA-malformed"], max_severity: severity }],
            },
          ],
        },
      ],
    });

    expect(assessment.blocking).toHaveLength(1);
    expect(assessment.blocking[0].severity).toBeNull();
  });

  it("rejects malformed OSV output instead of treating it as clean", () => {
    expect(() => assessOsvReport({})).toThrow("missing results");
    expect(() => assessOsvReport({ results: [{}] })).toThrow("missing packages");
    expect(() => assessOsvReport({ results: [{ packages: [{}] }] })).toThrow("missing groups");
    expect(() => assessOsvReport({ results: [{ packages: [{ groups: [{}] }] }] })).toThrow("missing ids");
  });

  it("classifies advisory timestamps deterministically", () => {
    const now = Date.parse("2026-09-12T12:00:00Z");
    expect(advisoryFreshness("2026-09-12T11:00:00Z", 3601, now)).toBe("fresh");
    expect(advisoryFreshness("2026-09-12T10:00:00Z", 3601, now)).toBe("stale");
    expect(advisoryFreshness("2026-09-12T12:00:01Z", 3601, now)).toBe("invalid");
    expect(advisoryFreshness("not-a-date", 3601, now)).toBe("invalid");
    expect(advisoryFreshness("2026-09-12T11:00:00Z", -1, now)).toBe("invalid");
    expect(advisoryFreshness("2026-09-12T11:00:00Z", 3601, Number.NaN)).toBe("invalid");
  });
});

describe("security report CLI findings", () => {
  it("runs Gitleaks report paths in-process and never prints secret-bearing fields", () => {
    const clean = fixture("gitleaks-clean.json", []);
    const finding = fixture("gitleaks-finding.json", [
      { RuleID: "generic-api-key", File: "fixture.ts", StartLine: 8, Secret: "must-not-print" },
    ]);
    const cleanOutput = outputCapture();
    const findingOutput = outputCapture();

    expect(runCli(["gitleaks", clean], cleanOutput.output)).toBe(0);
    expect(cleanOutput.logs).toEqual(["secret scan: no findings"]);
    expect(runCli(["gitleaks", finding], findingOutput.output)).toBe(1);
    expect(findingOutput.errors.join("\n")).toContain("generic-api-key at fixture.ts:8");
    expect(findingOutput.errors.join("\n")).not.toContain("must-not-print");
    expect(runCli(["gitleaks"], outputCapture().output)).toBe(2);
  });

  it("runs clean, lower-severity, blocking, and unknown OSV reports in-process", () => {
    const clean = fixture("osv-clean.json", { results: [] });
    const lower = fixture("osv-lower.json", {
      results: [
        { packages: [{ package: { name: "low", version: "1" }, groups: [{ ids: ["GHSA-low"], max_severity: 4 }] }] },
      ],
    });
    const blocking = fixture("osv-blocking.json", {
      results: [
        {
          packages: [
            { package: { name: "high", version: "2" }, groups: [{ ids: ["GHSA-high", 42], max_severity: "8.1" }] },
            { package: {}, groups: [{ ids: [], max_severity: "not-numeric" }] },
          ],
        },
      ],
    });
    const cleanOutput = outputCapture();
    const lowerOutput = outputCapture();
    const blockingOutput = outputCapture();

    expect(runCli(["osv", clean], cleanOutput.output)).toBe(0);
    expect(cleanOutput.logs).toEqual(["dependency scan: no known vulnerabilities"]);
    expect(runCli(["osv", lower, "5"], lowerOutput.output)).toBe(0);
    expect(lowerOutput.logs[0]).toContain("1 lower-severity");
    expect(runCli(["osv", blocking], blockingOutput.output)).toBe(1);
    expect(blockingOutput.errors.join("\n")).toContain("high@2: GHSA-high (CVSS 8.1)");
    expect(blockingOutput.errors.join("\n")).toContain(
      "unknown-package@unknown-version: unknown-advisory (CVSS unknown)",
    );
    expect(runCli(["osv"], outputCapture().output)).toBe(2);
  });
});

describe("security report CLI failures", () => {
  it("runs freshness and usage failures in-process with deterministic statuses", () => {
    const fresh = fixture("fresh.txt", new Date(Date.now() - 1_000).toISOString(), true);
    const stale = fixture("stale.txt", "2000-01-01T00:00:00Z", true);
    const future = fixture("future.txt", "2999-01-01T00:00:00Z", true);
    const usageOutput = outputCapture();

    expect(runCli(["freshness", fresh, "60"], outputCapture().output)).toBe(0);
    expect(runCli(["freshness", stale, "60"], outputCapture().output)).toBe(3);
    expect(runCli(["freshness", future, "60"], outputCapture().output)).toBe(2);
    expect(runCli(["freshness", fresh], outputCapture().output)).toBe(2);
    expect(runCli(["freshness"], outputCapture().output)).toBe(2);
    expect(runCli([], usageOutput.output)).toBe(2);
    expect(usageOutput.errors[0]).toContain("usage: report.mjs");
  });

  it("turns malformed or structurally invalid reports into an outage status", () => {
    const malformed = fixture("malformed.json", "{", true);
    const invalid = fixture("invalid-osv.json", {});
    const malformedOutput = outputCapture();
    const invalidOutput = outputCapture();

    expect(main(["osv", malformed], malformedOutput.output)).toBe(2);
    expect(malformedOutput.errors[0]).toContain("security report failed:");
    expect(main(["osv", invalid], invalidOutput.output)).toBe(2);
    expect(invalidOutput.errors[0]).toContain("missing results");
  });
});
