import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickSolutionFile, resolveScipDotnetCommand, scipDotnetIndexArgs } from "../src/graph/scip-dotnet.js";
import { ScipGraphProvider } from "../src/graph/scip.js";
import type { IndexerJob } from "../src/graph/roots.js";
import type { ToolCommand } from "../src/graph/toolchain.js";

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const exe = (dir: string, name: string) => writeFileSync(join(dir, name), "#!/bin/sh\n", { mode: 0o755 });

describe("resolveScipDotnetCommand", () => {
  it("honors the SCIP_DOTNET_CMD override verbatim", () => {
    expect(resolveScipDotnetCommand({ SCIP_DOTNET_CMD: "dotnet scip-dotnet" })).toEqual({
      argv0: "dotnet",
      args: ["scip-dotnet"],
    });
  });
  it("finds scip-dotnet on PATH", () => {
    const dir = tmp("srev-sd-path-");
    exe(dir, "scip-dotnet");
    expect(resolveScipDotnetCommand({ PATH: dir })).toEqual({ argv0: "scip-dotnet", args: [] });
  });
  it("falls back to the global dotnet tools directory under HOME or DOTNET_CLI_HOME", () => {
    const home = tmp("srev-sd-home-");
    mkdirSync(join(home, ".dotnet", "tools"), { recursive: true });
    exe(join(home, ".dotnet", "tools"), "scip-dotnet");
    const expected = { argv0: join(home, ".dotnet", "tools", "scip-dotnet"), args: [] };
    expect(resolveScipDotnetCommand({ PATH: "/nonexistent", HOME: home })).toEqual(expected);
    expect(resolveScipDotnetCommand({ PATH: "/nonexistent", DOTNET_CLI_HOME: home, HOME: "/nowhere" })).toEqual(
      expected,
    );
  });
  it("returns null when nothing is available", () => {
    expect(resolveScipDotnetCommand({ PATH: "/nonexistent", HOME: tmp("srev-sd-empty-") })).toBeNull();
    expect(resolveScipDotnetCommand({})).toBeNull();
  });
});

describe("pickSolutionFile", () => {
  it("prefers .slnx, then .sln, then a single .csproj", () => {
    const a = tmp("srev-sln-");
    writeFileSync(join(a, "App.sln"), "");
    writeFileSync(join(a, "App.slnx"), "");
    writeFileSync(join(a, "App.csproj"), "");
    expect(pickSolutionFile(a)).toBe(join(a, "App.slnx"));
    const b = tmp("srev-sln-");
    writeFileSync(join(b, "App.sln"), "");
    writeFileSync(join(b, "App.csproj"), "");
    expect(pickSolutionFile(b)).toBe(join(b, "App.sln"));
    const c = tmp("srev-sln-");
    writeFileSync(join(c, "Lib.csproj"), "");
    expect(pickSolutionFile(c)).toBe(join(c, "Lib.csproj"));
  });
  it("rejects ambiguous roots naming the candidates", () => {
    const dir = tmp("srev-sln-");
    writeFileSync(join(dir, "A.sln"), "");
    writeFileSync(join(dir, "B.sln"), "");
    expect(() => pickSolutionFile(dir)).toThrow(/A\.sln, B\.sln.*SCIP_DOTNET_SOLUTION/);
  });
  it("rejects roots with no solution or project file", () => {
    expect(() => pickSolutionFile(tmp("srev-sln-"))).toThrow(/no \.slnx, \.sln or \.csproj/);
  });
  it("uses SCIP_DOTNET_SOLUTION (relative or absolute) when set, and rejects a missing one", () => {
    const dir = tmp("srev-sln-");
    mkdirSync(join(dir, "build"));
    writeFileSync(join(dir, "build", "Ci.sln"), "");
    expect(pickSolutionFile(dir, "build/Ci.sln")).toBe(join(dir, "build", "Ci.sln"));
    expect(pickSolutionFile(dir, join(dir, "build", "Ci.sln"))).toBe(join(dir, "build", "Ci.sln"));
    expect(() => pickSolutionFile(dir, "nope.sln")).toThrow(/SCIP_DOTNET_SOLUTION.*nope\.sln/);
  });
});

describe("scipDotnetIndexArgs", () => {
  it("indexes the solution from the root, writes to the given path and excludes build output", () => {
    expect(scipDotnetIndexArgs("/r/App.sln", "/r", "/tmp/i/index.scip")).toEqual([
      "index",
      "/r/App.sln",
      "--working-directory",
      "/r",
      "--output",
      "/tmp/i/index.scip",
      "--exclude",
      "**/obj/**",
      "--exclude",
      "**/bin/**",
    ]);
  });
});

describe("C# degradation (planJobs)", () => {
  const JOBS: IndexerJob[] = [
    { language: "ts", root: "", hasSources: true },
    { language: "cs", root: "dotnet", hasSources: true },
    { language: "java", root: "svc", hasSources: true },
  ];
  class Probe extends ScipGraphProvider {
    dotnet: ToolCommand | null = null;
    java: ToolCommand | null = { argv0: "scip-java", args: [] };
    protected override discoverJobs(): IndexerJob[] {
      return JOBS;
    }
    protected override resolveDotnetCommand(): ToolCommand | null {
      return this.dotnet;
    }
    protected override resolveJavaCommand(): ToolCommand | null {
      return this.java;
    }
    plan() {
      return this.planJobs();
    }
  }
  it("drops cs jobs with an install hint when scip-dotnet is missing", () => {
    const { jobs, warnings } = new Probe({ repoRoot: "/tmp" }).plan();
    expect(jobs.map((j) => j.language)).toEqual(["ts", "java"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^C# indexing skipped for 1 root\(s\) \('dotnet'\)/);
    expect(warnings[0]).toMatch(/dotnet tool install --global scip-dotnet/);
    expect(warnings[0]).toMatch(/SCIP_DOTNET_CMD/);
  });
  it("reports both missing toolchains independently", () => {
    const p = new Probe({ repoRoot: "/tmp" });
    p.java = null;
    const { jobs, warnings } = p.plan();
    expect(jobs.map((j) => j.language)).toEqual(["ts"]);
    expect(warnings.map((w) => w.slice(0, 4))).toEqual(["Java", "C# i"]);
  });
  it("keeps cs jobs when the tool resolves", () => {
    const p = new Probe({ repoRoot: "/tmp" });
    p.dotnet = { argv0: "scip-dotnet", args: [] };
    expect(p.plan()).toEqual({ jobs: JOBS, warnings: [] });
  });
});

describe("SCIP_LANGS default", () => {
  it("enables cs alongside ts, py and java", () => {
    class Probe extends ScipGraphProvider {
      jobs() {
        return this.discoverJobs();
      }
    }
    const dir = tmp("srev-langs-");
    writeFileSync(join(dir, "App.sln"), "");
    const prev = process.env.SCIP_LANGS;
    delete process.env.SCIP_LANGS;
    try {
      expect(new Probe({ repoRoot: dir }).jobs()).toEqual([{ language: "cs", root: "", hasSources: false }]);
    } finally {
      if (prev !== undefined) process.env.SCIP_LANGS = prev;
    }
  });
});
