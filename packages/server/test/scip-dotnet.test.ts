import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** A committed two-project solution: Demo.App (console, Main) depends on Demo.Core via an interface. */
function writeDotnetFixture(dir: string): void {
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  const proj = (extra = "") =>
    `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n    <Nullable>enable</Nullable>\n    <ImplicitUsings>enable</ImplicitUsings>${extra}\n  </PropertyGroup>\n</Project>\n`;
  mkdirSync(join(dir, "src", "Demo.Core"), { recursive: true });
  mkdirSync(join(dir, "src", "Demo.App"), { recursive: true });
  writeFileSync(join(dir, "src", "Demo.Core", "Demo.Core.csproj"), proj());
  writeFileSync(
    join(dir, "src", "Demo.App", "Demo.App.csproj"),
    proj("\n    <OutputType>Exe</OutputType>").replace(
      "</Project>",
      '  <ItemGroup>\n    <ProjectReference Include="../Demo.Core/Demo.Core.csproj" />\n  </ItemGroup>\n</Project>',
    ),
  );
  writeFileSync(
    join(dir, "src", "Demo.Core", "TokenService.cs"),
    [
      "namespace Demo.Core;",
      "public interface ITokenService { string Resolve(string userId); }",
      "public class TokenService : ITokenService",
      "{",
      "    public string Resolve(string userId) => Mint(userId);",
      '    private static string Mint(string userId) => $"tok-{userId}";',
      "}",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "src", "Demo.App", "Program.cs"),
    [
      "using Demo.Core;",
      "namespace Demo.App;",
      "public class App",
      "{",
      "    private readonly ITokenService _tokens;",
      "    public App(ITokenService tokens) { _tokens = tokens; }",
      "    public string Run(string user) => _tokens.Resolve(user);",
      '    public static int Main(string[] args) { Console.WriteLine(new App(new TokenService()).Run("u1")); return 0; }',
      "}",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "Demo.sln"),
    [
      "Microsoft Visual Studio Solution File, Format Version 12.00",
      'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Demo.Core", "src/Demo.Core/Demo.Core.csproj", "{11111111-1111-1111-1111-111111111111}"',
      "EndProject",
      'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Demo.App", "src/Demo.App/Demo.App.csproj", "{22222222-2222-2222-2222-222222222222}"',
      "EndProject",
      "Global",
      "EndGlobal",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, ".gitignore"), "bin/\nobj/\n");
  git("add", ".");
  git("commit", "-m", "init");
}

// Real scip-dotnet run over a two-project solution — slow (restore + Roslyn),
// so one test, skipped when the tool is not on this machine.
describe("scip-dotnet integration", () => {
  it.skipIf(!resolveScipDotnetCommand())(
    "indexes a solution and derives method-level flows through an injected interface",
    { timeout: 300_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "srev-cs-"));
      try {
        writeDotnetFixture(dir);

        const prev = process.env.SCIP_LANGS;
        process.env.SCIP_LANGS = "cs";
        try {
          const provider = new ScipGraphProvider({ repoRoot: dir });
          const flows = await provider.getFlows();
          const main = flows.find((f) => f.name === "Main");
          expect(main, `expected a 'Main' flow, got: ${flows.map((f) => f.name).join(", ")}`).toBeDefined();
          const labels = main!.steps.map((s) => s.label);
          // Run -> ITokenService.Resolve bridges to TokenService.Resolve -> Mint.
          expect(labels).toEqual(expect.arrayContaining(["Main", "Run", "Resolve", "Mint"]));
          const mint = main!.steps.find((s) => s.label === "Mint")!;
          expect(mint.file).toBe("src/Demo.Core/TokenService.cs");
          expect(main!.entryReasons).toContain("cli");
        } finally {
          if (prev === undefined) delete process.env.SCIP_LANGS;
          else process.env.SCIP_LANGS = prev;
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
