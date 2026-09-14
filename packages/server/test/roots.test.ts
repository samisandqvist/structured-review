import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverLanguageRoots, languagePathspecs, rootHasSources } from "../src/graph/roots.js";

/** Lay out files under a fresh temp dir; keys are relative paths. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "srev-roots-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

describe("discoverLanguageRoots", () => {
  it("finds ts, py, and java roots by marker files", () => {
    const dir = fixture({
      "package.json": "{}",
      "web/app.ts": "export {};",
      "mcp/svc/pyproject.toml": "",
      "mcp/svc/app.py": "x = 1\n",
      "example-service/pom.xml": "<project/>",
      "example-service/src/Main.java": "class Main {}",
    });
    try {
      const jobs = discoverLanguageRoots(dir);
      expect(jobs).toEqual([
        { language: "ts", root: "", hasSources: true },
        { language: "java", root: "example-service", hasSources: true },
        { language: "py", root: "mcp/svc", hasSources: true },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("discoverLanguageRoots (cs)", () => {
  it("finds a C# root by solution or project file and drops project roots nested under a solution root", () => {
    const dir = fixture({
      "dotnet/Demo.sln": "",
      "dotnet/src/Demo.Core/Demo.Core.csproj": "<Project/>",
      "dotnet/src/Demo.Core/Token.cs": "class Token {}",
      "lonely/Lonely.csproj": "<Project/>",
      "lonely/Program.cs": "class P {}",
    });
    try {
      expect(discoverLanguageRoots(dir)).toEqual([
        { language: "cs", root: "dotnet", hasSources: true },
        { language: "cs", root: "lonely", hasSources: true },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not treat generated obj/ trees as roots or sources", () => {
    const dir = fixture({
      "svc/Svc.slnx": "",
      "svc/obj/Debug/net8.0/Svc.GlobalUsings.g.cs": "// generated",
      "svc/obj/project.assets.json": "{}",
    });
    try {
      expect(discoverLanguageRoots(dir)).toEqual([{ language: "cs", root: "svc", hasSources: false }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("discoverLanguageRoots (nesting and skips)", () => {
  it("skips roots nested inside a root of the same language", () => {
    const dir = fixture({
      "package.json": "{}",
      "packages/server/package.json": "{}",
      "packages/server/src/index.ts": "export {};",
    });
    try {
      const jobs = discoverLanguageRoots(dir);
      expect(jobs).toEqual([{ language: "ts", root: "", hasSources: true }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a py root nested inside a ts root", () => {
    const dir = fixture({
      "tsconfig.json": "{}",
      "src/a.ts": "export {};",
      "scripts/requirements.txt": "",
      "scripts/tool.py": "x = 1\n",
    });
    try {
      const jobs = discoverLanguageRoots(dir);
      expect(jobs).toEqual([
        { language: "ts", root: "", hasSources: true },
        { language: "py", root: "scripts", hasSources: true },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not descend into node_modules, hidden dirs, venvs, or build output", () => {
    const dir = fixture({
      "node_modules/dep/package.json": "{}",
      ".hidden/pyproject.toml": "",
      "svc/.venv/lib/pyproject.toml": "",
      "svc/pyproject.toml": "",
      "svc/app.py": "x = 1\n",
      "dist/package.json": "{}",
    });
    try {
      const jobs = discoverLanguageRoots(dir);
      expect(jobs).toEqual([{ language: "py", root: "svc", hasSources: true }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags a root with no sources of its language (hasSources=false)", () => {
    const dir = fixture({ "svc/pyproject.toml": "" });
    try {
      expect(discoverLanguageRoots(dir)).toEqual([{ language: "py", root: "svc", hasSources: false }]);
      expect(rootHasSources(join(dir, "svc"), "py")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("languagePathspecs", () => {
  it("covers source extensions and marker files under a nested root", () => {
    expect(languagePathspecs("py", "mcp/svc")).toEqual([
      ":(glob)mcp/svc/**/*.py",
      ":(glob)mcp/svc/**/pyproject.toml",
      ":(glob)mcp/svc/**/setup.py",
      ":(glob)mcp/svc/**/requirements.txt",
      ":(glob)mcp/svc/**/pyrightconfig.json",
      ":(glob)mcp/svc/**/setup.cfg",
      ":(glob)mcp/svc/**/poetry.lock",
      ":(glob)mcp/svc/**/uv.lock",
      ":(glob)mcp/svc/**/Pipfile.lock",
    ]);
  });

  it("anchors repo-root specs at any depth including the top level", () => {
    expect(languagePathspecs("ts", "")).toEqual([
      ":(glob)**/*.ts",
      ":(glob)**/*.tsx",
      ":(glob)**/*.mts",
      ":(glob)**/*.cts",
      ":(glob)**/tsconfig.json",
      ":(glob)**/package.json",
      ":(glob)**/tsconfig*.json",
      ":(glob)**/package-lock.json",
      ":(glob)**/pnpm-lock.yaml",
      ":(glob)**/yarn.lock",
    ]);
  });

  it("covers java sources, build files, and build-config extras", () => {
    expect(languagePathspecs("java", "example-service")).toEqual([
      ":(glob)example-service/**/*.java",
      ":(glob)example-service/**/pom.xml",
      ":(glob)example-service/**/build.gradle",
      ":(glob)example-service/**/build.gradle.kts",
      ":(glob)example-service/**/settings.gradle",
      ":(glob)example-service/**/settings.gradle.kts",
      ":(glob)example-service/**/gradle.properties",
      ":(glob)example-service/**/gradle.lockfile",
      ":(glob)example-service/**/maven-wrapper.properties",
      ":(glob)example-service/**/settings.xml",
    ]);
  });
});

describe("languagePathspecs (cs)", () => {
  it("covers C# sources, solution/project markers and build props under a root", () => {
    expect(languagePathspecs("cs", "dotnet")).toEqual([
      ":(glob)dotnet/**/*.cs",
      ":(glob)dotnet/**/*.sln",
      ":(glob)dotnet/**/*.slnx",
      ":(glob)dotnet/**/*.csproj",
      ":(glob)dotnet/**/Directory.Build.props",
      ":(glob)dotnet/**/Directory.Build.targets",
      ":(glob)dotnet/**/Directory.Packages.props",
      ":(glob)dotnet/**/global.json",
      ":(glob)dotnet/**/NuGet.config",
      ":(glob)dotnet/**/packages.lock.json",
    ]);
  });
});
