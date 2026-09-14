import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickSolutionFile, resolveScipDotnetCommand, scipDotnetIndexArgs } from "../src/graph/scip-dotnet.js";

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
