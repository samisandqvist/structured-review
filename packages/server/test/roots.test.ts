import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverLanguageRoots, languagePathspecs, rootHasSources } from "../src/graph/roots.js";

/** Lay out files under a fresh temp dir; keys are relative paths. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "crw-roots-"));
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
      "introspector/pom.xml": "<project/>",
      "introspector/src/Main.java": "class Main {}",
    });
    try {
      const jobs = discoverLanguageRoots(dir);
      expect(jobs).toEqual([
        { language: "ts", root: "", hasSources: true },
        { language: "java", root: "introspector", hasSources: true },
        { language: "py", root: "mcp/svc", hasSources: true },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
    expect(languagePathspecs("java", "introspector")).toEqual([
      ":(glob)introspector/**/*.java",
      ":(glob)introspector/**/pom.xml",
      ":(glob)introspector/**/build.gradle",
      ":(glob)introspector/**/build.gradle.kts",
      ":(glob)introspector/**/settings.gradle",
      ":(glob)introspector/**/settings.gradle.kts",
      ":(glob)introspector/**/gradle.properties",
      ":(glob)introspector/**/gradle.lockfile",
      ":(glob)introspector/**/maven-wrapper.properties",
      ":(glob)introspector/**/settings.xml",
    ]);
  });
});
