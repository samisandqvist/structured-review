# C# Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Review C# changes with method-level nodes and cross-file call flows by adding scip-dotnet as a fifth SCIP indexer job.

**Architecture:** `cs` becomes a new `IndexerLanguage` discovered by solution/project markers. A new `graph/scip-dotnet.ts` resolves the external `scip-dotnet` tool and picks the solution file; a new `graph/csharp-spans.ts` fills in the `enclosingRange` that scip-dotnet omits, so the unchanged graph builder produces nodes and edges. `scip.ts` gains one `cs` branch plus a generalised "external toolchain missing → drop jobs with a warning" planner shared with Java.

**Tech Stack:** TypeScript (strict), Vitest, Node `child_process`, scip-dotnet 0.2.14 (.NET global tool), .NET SDK 8.

**Spec:** `docs/superpowers/specs/2026-09-14-csharp-support-design.md`

## Global Constraints

- TypeScript strict mode; every new source file must meet 95% statements/lines/functions and 90% branches; changed lines 95% covered (`pnpm verify` enforces).
- Complexity limits per function: cyclomatic 15, cognitive 15, nesting 4, parameters 5, 80 non-blank non-comment lines. Split helpers rather than exceed.
- `pnpm lint` must report `0 blocking` after every change to `packages/server/src/graph/scip.ts` (legacy findings there are baselined; new ones block).
- Indexer absence degrades with a visible warning; indexer failure (non-zero exit / empty index for a root with sources) is an `IndexError`. scip-dotnet exits 0 on compile errors, so partial indexes are accepted.
- Run tests from `packages/server`: `pnpm exec vitest run test/<file>.test.ts`. Run the repo gate from the root: `pnpm verify`. After runtime changes: `pnpm build && pnpm build:plugin` before `pnpm verify` (plugin freshness check).
- Commit after each task. Prettier: `pnpm exec prettier --write <files>` before committing.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `packages/server/src/graph/toolchain.ts` (new) | `ToolCommand` type, `findOnPath`, `parseCommandOverride` shared by Java and C# resolvers |
| `packages/server/src/graph/scip-dotnet.ts` (new) | `resolveScipDotnetCommand`, `pickSolutionFile`, `scipDotnetIndexArgs`, install hint |
| `packages/server/src/graph/csharp-spans.ts` (new) | `synthesizeCsharpSpans`, `memberEndLine` scanner |
| `packages/server/src/graph/roots.ts` | `cs` language: markers (glob suffixes), `.cs` sources, fingerprint extras, skip `obj/` |
| `packages/server/src/graph/scip.ts` | `cs` job branch, generalised degradation planner, `.ctor` label, span hook, C# entry evidence wiring |
| `packages/server/src/graph/entry-points.ts` | `csharpEntryReasons` |
| `packages/server/src/util.ts` | `isTestFile` C# patterns |
| `packages/server/test/toolchain.test.ts`, `scip-dotnet.test.ts`, `csharp-spans.test.ts` (new) + additions to `roots.test.ts`, `scip-multi.test.ts`, `util.test.ts`, `entry-points.test.ts` | Tests |
| Docs/CI: `AGENTS.md`, `README.md`, `docs/architecture.md`, `docs/cli-and-configuration.md`, `docs/harness.md`, `scripts/build-plugin.mjs`, `.claude-plugin/marketplace.json`, `.github/workflows/ci.yml` | User-facing text and CI toolchain |

---

### Task 1: Shared toolchain helpers (`toolchain.ts`)

Behaviour-preserving extraction so the C# resolver can reuse PATH lookup without importing `scip.ts` (which would be circular).

**Files:**
- Create: `packages/server/src/graph/toolchain.ts`
- Modify: `packages/server/src/graph/scip.ts` (remove local `findOnPath`, `ScipJavaCommand` becomes an alias)
- Test: `packages/server/test/toolchain.test.ts`

**Interfaces:**
- Produces: `export interface ToolCommand { argv0: string; args: string[] }`; `export function findOnPath(bin: string, env: NodeJS.ProcessEnv): boolean`; `export function parseCommandOverride(raw: string | undefined): ToolCommand | undefined` (undefined when unset/blank).

- [x] **Step 1: Write the failing tests**

```ts
// packages/server/test/toolchain.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findOnPath, parseCommandOverride } from "../src/graph/toolchain.js";

describe("parseCommandOverride", () => {
  it("splits a command string into argv0 and args", () => {
    expect(parseCommandOverride("cs launch foo --")).toEqual({ argv0: "cs", args: ["launch", "foo", "--"] });
  });
  it("returns undefined for unset or blank input", () => {
    expect(parseCommandOverride(undefined)).toBeUndefined();
    expect(parseCommandOverride("   ")).toBeUndefined();
  });
});

describe("findOnPath", () => {
  it("finds an executable in a PATH directory and ignores empty entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "srev-path-"));
    writeFileSync(join(dir, "tool"), "#!/bin/sh\n", { mode: 0o755 });
    expect(findOnPath("tool", { PATH: `:${dir}:` })).toBe(true);
    expect(findOnPath("missing", { PATH: dir })).toBe(false);
    expect(findOnPath("tool", {})).toBe(false);
  });
});
```

- [x] **Step 2: Run to verify failure**

Run: `cd packages/server && pnpm exec vitest run test/toolchain.test.ts`
Expected: FAIL — cannot resolve `../src/graph/toolchain.js`.

- [x] **Step 3: Create the module and switch `scip.ts` to it**

```ts
// packages/server/src/graph/toolchain.ts
import { accessSync, constants as fsConstants } from "node:fs";
import { join } from "node:path";

/** An external indexer launcher: argv0 may be a bare name re-resolved on PATH at spawn time. */
export interface ToolCommand {
  argv0: string;
  args: string[];
}

/** `SCIP_*_CMD` overrides are whitespace-split and used verbatim; unset/blank → undefined. */
export function parseCommandOverride(raw: string | undefined): ToolCommand | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const [argv0, ...args] = trimmed.split(/\s+/);
  return argv0 ? { argv0, args } : undefined;
}

export function findOnPath(bin: string, env: NodeJS.ProcessEnv): boolean {
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try {
      accessSync(join(dir, bin), fsConstants.X_OK);
      return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}
```

In `scip.ts`:
- Add `import { findOnPath, parseCommandOverride, type ToolCommand } from "./toolchain.js";`
- Replace `export interface ScipJavaCommand { argv0: string; args: string[]; }` with `export type ScipJavaCommand = ToolCommand;`
- In `resolveScipJavaCommand`, replace the override block with:
  ```ts
  const override = parseCommandOverride(env.SCIP_JAVA_CMD);
  if (override) return override;
  ```
- Delete the module-level `function findOnPath(...)` and, if now unused, the `accessSync`/`fsConstants` imports.

- [x] **Step 4: Run tests and lint**

Run: `cd packages/server && pnpm exec vitest run test/toolchain.test.ts test/scip-java.test.ts && cd ../.. && pnpm lint | tail -1 && pnpm exec tsc --noEmit -p packages/server`
Expected: both files PASS, `0 blocking`, tsc clean.

- [x] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/server/src/graph/toolchain.ts packages/server/src/graph/scip.ts packages/server/test/toolchain.test.ts
git add packages/server/src/graph/toolchain.ts packages/server/src/graph/scip.ts packages/server/test/toolchain.test.ts
git commit -m "refactor(scip): extract shared toolchain lookup helpers" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `cs` language in root discovery

**Files:**
- Modify: `packages/server/src/graph/roots.ts`
- Test: `packages/server/test/roots.test.ts`

**Interfaces:**
- Produces: `IndexerLanguage = "ts" | "py" | "java" | "cs"`; markers may be suffix globs (`*.sln`); `SKIP_DIRS` includes `obj`.

- [x] **Step 1: Write the failing tests** (append inside the existing `describe("discoverLanguageRoots")` and add a pathspec case)

```ts
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
```

and in the `languagePathspecs` describe (add one if absent):

```ts
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
```

- [x] **Step 2: Run to verify failure**

Run: `cd packages/server && pnpm exec vitest run test/roots.test.ts`
Expected: FAIL — TypeScript/vitest reports `"cs"` not assignable / discovered roots `[]`.

- [x] **Step 3: Implement**

In `roots.ts`:
```ts
export type IndexerLanguage = "ts" | "py" | "java" | "cs";

const MARKERS: Record<IndexerLanguage, string[]> = {
  ts: ["tsconfig.json", "package.json"],
  py: ["pyproject.toml", "setup.py", "requirements.txt"],
  java: ["pom.xml", "build.gradle", "build.gradle.kts"],
  // `*.ext` entries match by suffix (solution/project files carry the project's name).
  cs: ["*.sln", "*.slnx", "*.csproj"],
};

const SOURCE_EXTS: Record<IndexerLanguage, string[]> = {
  ts: [".ts", ".tsx", ".mts", ".cts"],
  py: [".py"],
  java: [".java"],
  cs: [".cs"],
};

const FINGERPRINT_EXTRAS: Record<IndexerLanguage, string[]> = {
  /* existing ts/py/java unchanged */
  cs: [
    "Directory.Build.props",
    "Directory.Build.targets",
    "Directory.Packages.props",
    "global.json",
    "NuGet.config",
    "packages.lock.json",
  ],
};

/** Marker match: exact file name, or suffix when the marker is a `*.ext` glob. */
function matchesMarker(fileName: string, marker: string): boolean {
  return marker.startsWith("*.") ? fileName.endsWith(marker.slice(1)) : fileName === marker;
}

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "coverage", "venv", "__pycache__", "obj"]);
```
In `walk`, replace the marker test with:
```ts
    if (MARKERS[language].some((m) => [...fileNames].some((f) => matchesMarker(f, m)))) out.push({ language, root: rel });
```
`languagePathspecs` needs no change: `**/${m}` with `m = "*.sln"` already yields `**/*.sln`. Update the header comment ("Java is detected here but only enabled in Phase 4") to: "Every language here is enabled by default; callers filter by `SCIP_LANGS` (see scip.ts)."

- [x] **Step 4: Run tests**

Run: `cd packages/server && pnpm exec vitest run test/roots.test.ts test/scip-multi.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/server/src/graph/roots.ts packages/server/test/roots.test.ts
git add packages/server/src/graph/roots.ts packages/server/test/roots.test.ts
git commit -m "feat(scip): discover C# roots from solution and project files" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: scip-dotnet command resolution and solution selection

**Files:**
- Create: `packages/server/src/graph/scip-dotnet.ts`
- Test: `packages/server/test/scip-dotnet.test.ts`

**Interfaces:**
- Consumes: `findOnPath`, `parseCommandOverride`, `ToolCommand` from Task 1.
- Produces: `resolveScipDotnetCommand(env?): ToolCommand | null`; `pickSolutionFile(absRoot: string, override?: string): string` (absolute path; throws `Error` with a user-facing message); `scipDotnetIndexArgs(solution: string, absRoot: string, indexPath: string): string[]`; `SCIP_DOTNET_INSTALL_HINT: string`.

- [x] **Step 1: Write the failing tests**

```ts
// packages/server/test/scip-dotnet.test.ts
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pickSolutionFile,
  resolveScipDotnetCommand,
  scipDotnetIndexArgs,
} from "../src/graph/scip-dotnet.js";

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
    expect(resolveScipDotnetCommand({ PATH: "/nonexistent", DOTNET_CLI_HOME: home, HOME: "/nowhere" })).toEqual(expected);
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
      "index", "/r/App.sln", "--working-directory", "/r", "--output", "/tmp/i/index.scip",
      "--exclude", "**/obj/**", "--exclude", "**/bin/**",
    ]);
  });
});
```

- [x] **Step 2: Run to verify failure**

Run: `cd packages/server && pnpm exec vitest run test/scip-dotnet.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement**

```ts
// packages/server/src/graph/scip-dotnet.ts
import { accessSync, constants as fsConstants, existsSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { findOnPath, parseCommandOverride, type ToolCommand } from "./toolchain.js";

/**
 * scip-dotnet is a .NET global tool we cannot bundle. Resolution order:
 * SCIP_DOTNET_CMD override, `scip-dotnet` on PATH, then the default global
 * tool location `~/.dotnet/tools`. Null = unavailable; callers degrade C#
 * jobs with a visible warning, never silently.
 */
export const SCIP_DOTNET_INSTALL_HINT =
  "install it with 'dotnet tool install --global scip-dotnet' (needs the .NET SDK 8 or newer), or set SCIP_DOTNET_CMD";

export function resolveScipDotnetCommand(env: NodeJS.ProcessEnv = process.env): ToolCommand | null {
  const override = parseCommandOverride(env.SCIP_DOTNET_CMD);
  if (override) return override;
  if (findOnPath("scip-dotnet", env)) return { argv0: "scip-dotnet", args: [] };
  const home = env.DOTNET_CLI_HOME ?? env.HOME;
  if (!home) return null;
  const tool = join(home, ".dotnet", "tools", "scip-dotnet");
  try {
    accessSync(tool, fsConstants.X_OK);
    return { argv0: tool, args: [] };
  } catch {
    return null;
  }
}

const SOLUTION_EXTS = [".slnx", ".sln", ".csproj"];

/**
 * The one file scip-dotnet indexes for a root: SCIP_DOTNET_SOLUTION when set,
 * else the single `.slnx`, else the single `.sln`, else the single `.csproj`.
 * A `.csproj` indexes only that project, so solutions win. Ambiguity is an
 * error the user resolves with SCIP_DOTNET_SOLUTION.
 */
export function pickSolutionFile(absRoot: string, override?: string): string {
  const chosen = override?.trim();
  if (chosen) {
    const path = isAbsolute(chosen) ? chosen : join(absRoot, chosen);
    if (!existsSync(path)) {
      throw new Error(`SCIP_DOTNET_SOLUTION points at '${chosen}', which does not exist under '${absRoot}'`);
    }
    return path;
  }
  const names = readdirSync(absRoot, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
  for (const ext of SOLUTION_EXTS) {
    const found = names.filter((n) => n.endsWith(ext));
    if (found.length === 1) return join(absRoot, found[0]!);
    if (found.length > 1) {
      throw new Error(
        `multiple ${ext} files in '${absRoot}' (${found.join(", ")}); set SCIP_DOTNET_SOLUTION to choose one`,
      );
    }
  }
  throw new Error(`no .slnx, .sln or .csproj file in '${absRoot}'`);
}

/** scip-dotnet runs `dotnet restore` itself; generated sources under obj/ and bin/ are excluded. */
export function scipDotnetIndexArgs(solution: string, absRoot: string, indexPath: string): string[] {
  return [
    "index", solution,
    "--working-directory", absRoot,
    "--output", indexPath,
    "--exclude", "**/obj/**",
    "--exclude", "**/bin/**",
  ];
}
```

- [x] **Step 4: Run tests**

Run: `cd packages/server && pnpm exec vitest run test/scip-dotnet.test.ts`
Expected: PASS (all).

- [x] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/server/src/graph/scip-dotnet.ts packages/server/test/scip-dotnet.test.ts
git add packages/server/src/graph/scip-dotnet.ts packages/server/test/scip-dotnet.test.ts
git commit -m "feat(scip): resolve the scip-dotnet tool and the solution file to index" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Span synthesis for C# definitions (`csharp-spans.ts`)

**Files:**
- Create: `packages/server/src/graph/csharp-spans.ts`
- Test: `packages/server/test/csharp-spans.test.ts`

**Interfaces:**
- Consumes: `ScipDocument`, `ScipOccurrence` types from `scip.ts` (type-only import; no runtime cycle).
- Produces: `synthesizeCsharpSpans(docs: ScipDocument[], readFile: (relativePath: string) => string): ScipDocument[]`; `memberEndLine(lines: string[], startLine: number): number` (0-based in/out; returns `startLine` when no end is found).

- [x] **Step 1: Write the failing tests**

```ts
// packages/server/test/csharp-spans.test.ts
import { describe, it, expect } from "vitest";
import { memberEndLine, synthesizeCsharpSpans } from "../src/graph/csharp-spans.js";
import type { ScipDocument } from "../src/graph/scip.js";

describe("memberEndLine", () => {
  it("ends a block body at the brace that closes the first opening brace", () => {
    expect(memberEndLine(["void A()", "{", "  if (x) { y(); }", "}", "void B() {}"], 0)).toBe(3);
  });
  it("ends an expression-bodied member at its semicolon", () => {
    expect(memberEndLine(["int F(int a) => a + 1;", "int G() => 2;"], 0)).toBe(0);
  });
  it("ends an interface or abstract member at its semicolon", () => {
    expect(memberEndLine(["  string Resolve(string id);", "  string Other();"], 0)).toBe(0);
  });
  it("ignores braces and semicolons inside strings, chars and comments", () => {
    const lines = ["void A() {", '  var s = "}"; // }', "  /* } ; */", "  var c = '}';", "}"];
    expect(memberEndLine(lines, 0)).toBe(4);
  });
  it("handles verbatim strings with doubled quotes", () => {
    expect(memberEndLine(["void A() {", '  var s = @"a""}";', "}"], 0)).toBe(2);
  });
  it("handles raw string literals", () => {
    expect(memberEndLine(["void A() {", '  var s = """', "  }", '  """;', "}"], 0)).toBe(4);
  });
  it("handles interpolation holes containing quotes and braces", () => {
    expect(memberEndLine(['string A(int n) => $"{(n > 0 ? "}" : "{")}";', "int B() => 1;"], 0)).toBe(0);
  });
  it("skips preprocessor directive lines", () => {
    expect(memberEndLine(["void A()", "{", "#if DEBUG", '  Log("{");', "#endif", "}"], 0)).toBe(5);
  });
  it("spans multi-line block comments", () => {
    expect(memberEndLine(["void A() {", "  /* start", "  } still comment", "  */ x();", "}"], 0)).toBe(4);
  });
  it("returns the start line when the member never closes", () => {
    expect(memberEndLine(["void A() {", "  x();"], 0)).toBe(0);
  });
});

describe("synthesizeCsharpSpans", () => {
  const METHOD = "scip-dotnet nuget . . Core/TokenService#Resolve().";
  const PROP = "scip-dotnet nuget . . Core/TokenService#Hits.";
  const SPANNED = "scip-dotnet nuget . . Core/TokenService#Mint().";
  const source = [
    "public class TokenService {",
    "  public int Hits { get; private set; }",
    "  public string Resolve(string id)",
    "  {",
    "    return Mint(id);",
    "  }",
    "  private static string Mint(string id) => id;",
    "}",
  ].join("\n");
  const doc: ScipDocument = {
    relativePath: "src/TokenService.cs",
    occurrences: [
      { symbol: PROP, symbolRoles: 1, range: [1, 13, 17] },
      { symbol: METHOD, symbolRoles: 1, range: [2, 16, 23] },
      { symbol: SPANNED, symbolRoles: 1, range: [6, 24, 28], enclosingRange: [6, 2, 6, 47] },
      { symbol: METHOD, symbolRoles: 0, range: [4, 11, 18] },
      { symbol: "local 0", symbolRoles: 1, range: [4, 4, 5] },
    ],
  };

  it("adds body spans to method definitions only, leaving existing spans and non-methods alone", () => {
    const [out] = synthesizeCsharpSpans([doc], () => source);
    const byIndex = out!.occurrences!;
    expect(byIndex[0]!.enclosingRange).toBeUndefined(); // property
    expect(byIndex[1]!.enclosingRange).toEqual([2, 0, 5, 3]); // Resolve: lines 2..5, last line "  }" has 3 chars
    expect(byIndex[2]!.enclosingRange).toEqual([6, 2, 6, 47]); // already spanned: untouched
    expect(byIndex[3]!.enclosingRange).toBeUndefined(); // reference, not definition
    expect(byIndex[4]!.enclosingRange).toBeUndefined(); // local
  });
  it("does not mutate its input and leaves non-.cs documents unchanged", () => {
    const before = JSON.stringify(doc);
    const java: ScipDocument = { relativePath: "A.java", occurrences: [{ symbol: "x#m().", symbolRoles: 1, range: [0, 0, 1] }] };
    const out = synthesizeCsharpSpans([doc, java], () => source);
    expect(JSON.stringify(doc)).toBe(before);
    expect(out[1]).toBe(java);
  });
  it("leaves a document unchanged when its source cannot be read", () => {
    const [out] = synthesizeCsharpSpans([doc], () => { throw new Error("ENOENT"); });
    expect(out!.occurrences![1]!.enclosingRange).toBeUndefined();
  });
});
```

- [x] **Step 2: Run to verify failure**

Run: `cd packages/server && pnpm exec vitest run test/csharp-spans.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement**

```ts
// packages/server/src/graph/csharp-spans.ts
import type { ScipDocument, ScipOccurrence } from "./scip.js";

/**
 * scip-dotnet (through 0.2.14) emits no `enclosing_range` on definitions, so
 * the graph builder would create no C# nodes at all. Derive each method-like
 * member's body span from source: from the definition line to the `}` that
 * closes its first `{`, or to the first top-level `;` seen before any `{`
 * (expression-bodied, abstract, interface, partial and extern members).
 *
 * Only `...().` symbols (methods, constructors, overloads) receive spans;
 * properties, fields, events and indexers stay node-less, so no per-language
 * node filter is needed. Definitions that already carry a span are untouched,
 * which makes this a no-op if upstream ships enclosing ranges.
 *
 * Known limits: nested interpolation holes share one brace counter, and
 * verbatim-interpolated strings (`$@"..."`) skip their holes entirely.
 */
export function synthesizeCsharpSpans(
  docs: ScipDocument[],
  readFile: (relativePath: string) => string,
): ScipDocument[] {
  return docs.map((doc) => {
    const path = doc.relativePath ?? "";
    if (!path.endsWith(".cs") || !(doc.occurrences ?? []).some(needsSpan)) return doc;
    let lines: string[];
    try {
      lines = readFile(path).split("\n");
    } catch {
      return doc;
    }
    const occurrences = doc.occurrences!.map((o) => (needsSpan(o) ? withSpan(o, lines) : o));
    return { ...doc, occurrences };
  });
}

const ROLE_DEFINITION = 0x1;

function needsSpan(o: ScipOccurrence): boolean {
  if (!((o.symbolRoles ?? 0) & ROLE_DEFINITION) || o.enclosingRange || o.range?.[0] === undefined) return false;
  return !!o.symbol && !o.symbol.startsWith("local ") && /\)\.$/.test(o.symbol);
}

function withSpan(o: ScipOccurrence, lines: string[]): ScipOccurrence {
  const start = o.range![0]!;
  const end = memberEndLine(lines, start);
  return { ...o, enclosingRange: [start, 0, end, lines[end]?.length ?? 0] };
}

type Mode = "code" | "hole" | "line-comment" | "block-comment" | "string" | "char" | "verbatim" | "raw" | "interp";

interface Scan {
  modes: Mode[];
  depth: number;
  sawBrace: boolean;
  rawQuotes: number;
  holeDepth: number;
  done: boolean;
}

const top = (s: Scan): Mode => s.modes[s.modes.length - 1] ?? "code";

/** 0-based line where the member starting at `startLine` ends; `startLine` if never found. */
export function memberEndLine(lines: string[], startLine: number): number {
  const s: Scan = { modes: ["code"], depth: 0, sawBrace: false, rawQuotes: 0, holeDepth: 0, done: false };
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (top(s) === "line-comment") s.modes.pop();
    if (top(s) === "code" && /^\s*#/.test(line)) continue;
    for (let c = 0; c < line.length; c++) {
      c = step(s, line, c);
      if (s.done) return i;
    }
  }
  return startLine;
}

/** Consume the token at `c`; return the index of its last character. */
function step(s: Scan, line: string, c: number): number {
  switch (top(s)) {
    case "code":
    case "hole":
      return stepCode(s, line, c);
    case "line-comment":
      return line.length;
    case "block-comment":
      if (line.startsWith("*/", c)) s.modes.pop();
      return line.startsWith("*/", c) ? c + 1 : c;
    case "string":
      return stepQuoted(s, line, c, '"');
    case "char":
      return stepQuoted(s, line, c, "'");
    case "verbatim":
      if (line.startsWith('""', c)) return c + 1;
      if (line[c] === '"') s.modes.pop();
      return c;
    case "raw": {
      const closer = '"'.repeat(s.rawQuotes);
      if (!line.startsWith(closer, c)) return c;
      s.modes.pop();
      return c + s.rawQuotes - 1;
    }
    case "interp":
      return stepInterpolated(s, line, c);
  }
}

function stepQuoted(s: Scan, line: string, c: number, quote: string): number {
  if (line[c] === "\\") return c + 1;
  if (line[c] === quote) s.modes.pop();
  return c;
}

function stepInterpolated(s: Scan, line: string, c: number): number {
  const ch = line[c];
  if (ch === "\\") return c + 1;
  if (ch === "{") {
    if (line[c + 1] === "{") return c + 1;
    s.modes.push("hole");
    s.holeDepth = 0;
    return c;
  }
  if (ch === '"') s.modes.pop();
  return c;
}

function stepCode(s: Scan, line: string, c: number): number {
  const ch = line[c];
  const next = line[c + 1];
  if (ch === "/" && next === "/") {
    s.modes.push("line-comment");
    return line.length;
  }
  if (ch === "/" && next === "*") {
    s.modes.push("block-comment");
    return c + 1;
  }
  if (ch === "'") {
    s.modes.push("char");
    return c;
  }
  if (ch === '"') return openString(s, line, c);
  if (ch === "@" && next === '"') {
    s.modes.push("verbatim");
    return c + 1;
  }
  if (ch === "$") return openInterpolated(s, line, c);
  return top(s) === "hole" ? stepHoleBrace(s, ch, c) : stepMemberBrace(s, ch, c);
}

function openString(s: Scan, line: string, c: number): number {
  let quotes = 0;
  while (line[c + quotes] === '"') quotes++;
  if (quotes >= 3) {
    s.modes.push("raw");
    s.rawQuotes = quotes;
    return c + quotes - 1;
  }
  if (quotes === 2) return c + 1; // empty string literal ""
  s.modes.push("string");
  return c;
}

/** `$"…"` interpolated; `$@"…"`/`@$"…"` verbatim-interpolated (holes skipped); `$"""…"""` raw. */
function openInterpolated(s: Scan, line: string, c: number): number {
  const rest = line.slice(c, c + 3);
  if (rest === '$@"' || rest === '@$"') {
    s.modes.push("verbatim");
    return c + 2;
  }
  if (rest === '$""' && line[c + 3] === '"') return openString(s, line, c + 1);
  if (rest.startsWith('$"')) {
    s.modes.push("interp");
    return c + 1;
  }
  return c;
}

function stepHoleBrace(s: Scan, ch: string | undefined, c: number): number {
  if (ch === "{") s.holeDepth++;
  else if (ch === "}") {
    if (s.holeDepth === 0) s.modes.pop();
    else s.holeDepth--;
  }
  return c;
}

function stepMemberBrace(s: Scan, ch: string | undefined, c: number): number {
  if (ch === "{") {
    s.depth++;
    s.sawBrace = true;
  } else if (ch === "}") {
    s.depth--;
    if (s.sawBrace && s.depth === 0) s.done = true;
  } else if (ch === ";" && !s.sawBrace && s.depth === 0) {
    s.done = true;
  }
  return c;
}
```

Note on the `openString` `quotes === 2` branch: `""` is an empty literal; consuming both quotes keeps the scanner in code mode. For `$""` followed by a fourth quote we hand off to `openString` at the first quote so raw-interpolated strings are treated as raw.

- [x] **Step 4: Run tests and static checks**

Run: `cd packages/server && pnpm exec vitest run test/csharp-spans.test.ts && cd ../.. && pnpm lint | tail -1 && pnpm exec tsc --noEmit -p packages/server`
Expected: PASS; `0 blocking`; tsc clean. If a case fails, fix the scanner, not the test, unless the expectation itself is miscounted (recount the 0-based lines by hand first).

- [x] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/server/src/graph/csharp-spans.ts packages/server/test/csharp-spans.test.ts
git add packages/server/src/graph/csharp-spans.ts packages/server/test/csharp-spans.test.ts
git commit -m "feat(scip): synthesize C# member spans missing from scip-dotnet indexes" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Wire the `cs` job into the SCIP provider

**Files:**
- Modify: `packages/server/src/graph/scip.ts` (`discoverJobs`, `planJobs`, `runIndexer`, `labelOf`, new `resolveDotnetCommand` seam, new `indexerCommand`)
- Test: `packages/server/test/scip-dotnet.test.ts` (degradation + label cases), `packages/server/test/scip-multi.test.ts` (`.ctor` label)

**Interfaces:**
- Consumes: Task 3 exports; Task 4 `synthesizeCsharpSpans`; Task 1 `ToolCommand`.
- Produces: `protected resolveDotnetCommand(): ToolCommand | null` seam; `SCIP_LANGS` default `"ts,py,java,cs"`; C# warning text `C# indexing skipped for N root(s) (...): scip-dotnet not found; install it with 'dotnet tool install --global scip-dotnet' (needs the .NET SDK 8 or newer), or set SCIP_DOTNET_CMD. C# changes appear as residual-only until then.`

- [x] **Step 1: Write the failing tests**

Append to `scip-dotnet.test.ts`:
```ts
import { ScipGraphProvider } from "../src/graph/scip.js";
import type { IndexerJob } from "../src/graph/roots.js";
import type { ToolCommand } from "../src/graph/toolchain.js";

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
    const dir = mkdtempSync(join(tmpdir(), "srev-langs-"));
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
```
Append to the `java symbol shapes` (or a new `c# symbol shapes`) describe in `scip-multi.test.ts`:
```ts
describe("c# symbol shapes", () => {
  const CTOR = "scip-dotnet nuget . . Controllers/TokenController#`.ctor`().";
  const GET = "scip-dotnet nuget . . Controllers/TokenController#Get().";
  const OVERLOAD = "scip-dotnet nuget . . Core/TokenService#Resolve(+1).";
  it("labels constructors with the class name and keeps overloads as nodes", () => {
    const documents: ScipDocument[] = [
      {
        relativePath: "src/TokenController.cs",
        occurrences: [
          { symbol: CTOR, symbolRoles: 1, range: [3, 11, 26], enclosingRange: [3, 0, 3, 60] },
          { symbol: GET, symbolRoles: 1, range: [5, 32, 35], enclosingRange: [5, 0, 5, 70] },
          { symbol: OVERLOAD, symbolRoles: 1, range: [8, 18, 25], enclosingRange: [8, 0, 8, 80] },
        ],
      },
    ];
    const g = buildGraphFromIndex({ documents }, "/repo");
    expect(g.nodes.get(CTOR)?.label).toBe("TokenController");
    expect(g.nodes.get(GET)?.label).toBe("Get");
    expect(g.nodes.get(OVERLOAD)?.label).toBe("Resolve");
  });
});
```

- [x] **Step 2: Run to verify failure**

Run: `cd packages/server && pnpm exec vitest run test/scip-dotnet.test.ts test/scip-multi.test.ts`
Expected: FAIL — `resolveDotnetCommand` is not a member; ctor label is `` `.ctor` `` or null; SCIP_LANGS default excludes cs.

- [x] **Step 3: Implement in `scip.ts`**

Imports:
```ts
import { pickSolutionFile, resolveScipDotnetCommand, scipDotnetIndexArgs, SCIP_DOTNET_INSTALL_HINT } from "./scip-dotnet.js";
import { synthesizeCsharpSpans } from "./csharp-spans.js";
import type { IndexerLanguage } from "./roots.js"; // extend the existing roots import
```

`discoverJobs`: change the default string to `"ts,py,java,cs"` and the doc comment.

Add the seam next to `resolveJavaCommand`:
```ts
  /** Test seam over the module-level resolver. */
  protected resolveDotnetCommand(): ToolCommand | null {
    return resolveScipDotnetCommand();
  }
```

Replace `planJobs` with a table-driven version (keep the Java message text byte-identical):
```ts
  /** Unbundled toolchains: when one is missing, its jobs drop with a warning instead of failing the session. */
  private externalToolchains(): { language: IndexerLanguage; available: () => boolean; skipped: (n: number, roots: string) => string }[] {
    return [
      {
        language: "java",
        available: () => this.resolveJavaCommand() !== null,
        skipped: (n, roots) =>
          `Java indexing skipped for ${n} root(s) (${roots}): scip-java toolchain not found. ` +
          `Install coursier ('cs') plus a JDK and Maven (scip-java runs via ` +
          `'cs launch com.sourcegraph:scip-java_2.13:${SCIP_JAVA_DEFAULT_VERSION} -M com.sourcegraph.scip_java.ScipJava -- index'), ` +
          `or set SCIP_JAVA_CMD. Java changes appear as residual-only until then.`,
      },
      {
        language: "cs",
        available: () => this.resolveDotnetCommand() !== null,
        skipped: (n, roots) =>
          `C# indexing skipped for ${n} root(s) (${roots}): scip-dotnet not found; ${SCIP_DOTNET_INSTALL_HINT}. ` +
          `C# changes appear as residual-only until then.`,
      },
    ];
  }

  /**
   * Jobs to actually run plus degradation warnings. A missing external
   * toolchain must not fail (or silently hollow out) the other languages'
   * session: its jobs drop with a warning that surfaces in session
   * diagnostics; their files stay visible as residual-only changes. A
   * present-but-failing toolchain is NOT handled here — runIndexer throws
   * IndexError loudly for that.
   */
  protected planJobs(): { jobs: IndexerJob[]; warnings: string[] } {
    let jobs = this.discoverJobs();
    const warnings: string[] = [];
    for (const tool of this.externalToolchains()) {
      const affected = jobs.filter((j) => j.language === tool.language);
      if (affected.length === 0 || tool.available()) continue;
      warnings.push(tool.skipped(affected.length, affected.map((j) => `'${j.root || "."}'`).join(", ")));
      jobs = jobs.filter((j) => j.language !== tool.language);
    }
    return { jobs, warnings };
  }
```

Split `runIndexer`: extract the per-language command into `indexerCommand` and keep `runIndexer` as the exec/decode shell.
```ts
  /** argv for one job's indexer. Throws IndexError when an external toolchain is absent. */
  private indexerCommand(job: IndexerJob, absRoot: string, indexPath: string): ToolCommand {
    const where = `root '${job.root || "."}'`;
    if (job.language === "ts") {
      const binJs = resolveIndexerBin("@sourcegraph/scip-typescript", "scip-typescript");
      return { argv0: process.execPath, args: [binJs, "index", "--infer-tsconfig", "--output", indexPath] };
    }
    if (job.language === "py") {
      const binJs = resolveIndexerBin("@sourcegraph/scip-python", "scip-python");
      const projectName = job.root.replace(/[^A-Za-z0-9._-]+/g, "-") || "repo";
      return { argv0: process.execPath, args: [binJs, "index", ".", "--output", indexPath, "--project-name", projectName] };
    }
    if (job.language === "java") {
      // Route through the resolveJavaCommand() seam so a subclass overriding it
      // for planning also controls execution.
      const cmd = this.resolveJavaCommand();
      if (!cmd) throw new IndexError(`scip-java toolchain not found for ${where}: install coursier ('cs') plus a JDK and Maven, or set SCIP_JAVA_CMD`);
      return { argv0: cmd.argv0, args: [...cmd.args, "index", "--output", indexPath] };
    }
    const cmd = this.resolveDotnetCommand();
    if (!cmd) throw new IndexError(`scip-dotnet not found for ${where}: ${SCIP_DOTNET_INSTALL_HINT}`);
    let solution: string;
    try {
      solution = pickSolutionFile(absRoot, process.env.SCIP_DOTNET_SOLUTION);
    } catch (e) {
      throw new IndexError(`cs ${where}: ${(e as Error).message}`);
    }
    return { argv0: cmd.argv0, args: [...cmd.args, ...scipDotnetIndexArgs(solution, absRoot, indexPath)] };
  }
```
The old `else { throw new IndexError("no indexer available…") }` branch disappears: with four languages every `IndexerLanguage` is handled, and TypeScript's exhaustiveness makes the final branch `cs`.

In `runIndexer`, replace the whole inner `if/else if` chain with:
```ts
      try {
        const cmd = this.indexerCommand(job, absRoot, indexPath);
        execFileSync(cmd.argv0, cmd.args, { cwd: absRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      } catch (e) { /* unchanged: rethrow IndexError, wrap others */ }
```
and between decoding and rerooting:
```ts
      let documents = idx.documents ?? [];
      if (job.language === "cs") {
        documents = synthesizeCsharpSpans(documents, (rel) => readFileSync(join(absRoot, rel), "utf8"));
      }
      const docs = rerootDocuments(documents, job.root, absRoot);
```
(`scip-dotnet --working-directory <absRoot>` writes `relativePath` relative to that directory, which is what the reader joins onto.)

`labelOf`: after the Java constructor line add
```ts
  // C# constructors (`Cls#`.ctor``): label with the class name.
  const csCtor = s.match(/([A-Za-z0-9_$]+)#`\.ctor`$/);
  if (csCtor) return csCtor[1] ?? null;
```
(`s` has already had the `()` descriptor and trailing `.` stripped, so the symbol ends in `` #`.ctor` ``.)

- [x] **Step 4: Run tests, lint, typecheck**

Run: `cd packages/server && pnpm exec vitest run test/scip-dotnet.test.ts test/scip-multi.test.ts test/scip-java.test.ts test/scip-cache.test.ts test/routes.test.ts && cd ../.. && pnpm lint | tail -1 && pnpm exec tsc --noEmit -p packages/server`
Expected: PASS (the real scip-java integration case runs when `cs` is on PATH); `0 blocking`; tsc clean. If lint reports a new cognitive-complexity finding on `indexerCommand`, move the `cs` block into `private dotnetCommand(absRoot, indexPath, where): ToolCommand`.

- [x] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/server/src/graph/scip.ts packages/server/test/scip-dotnet.test.ts packages/server/test/scip-multi.test.ts
git add packages/server/src/graph/scip.ts packages/server/test/scip-dotnet.test.ts packages/server/test/scip-multi.test.ts
git commit -m "feat(scip): run scip-dotnet jobs with span synthesis and toolchain degradation" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: C# test-file and entry-point heuristics

**Files:**
- Modify: `packages/server/src/util.ts` (`isTestFile`), `packages/server/src/graph/entry-points.ts` (`csharpEntryReasons`), `packages/server/src/graph/scip.ts` (`getFlows` evidence wiring)
- Test: `packages/server/test/util.test.ts`, `packages/server/test/entry-points.test.ts`

**Interfaces:**
- Produces: `export function csharpEntryReasons(root: string, file: string, node: { label: string; startLine: number }, cache?: Map<string, string[]>): EntryReason[]` returning `"http-route"` for controller-action attributes and `"cli"` for `static … Main(`.

- [x] **Step 1: Write the failing tests**

`util.test.ts`, new case:
```ts
  it("matches C# test conventions", () => {
    expect(isTestFile("tests/Demo.Core.Tests/TokenServiceTests.cs")).toBe(true);
    expect(isTestFile("src/Demo.Core.Tests/TokenServiceTest.cs")).toBe(true); // *.Tests/ project folder
    expect(isTestFile("src/Demo.Core/TokenServiceSpec.cs")).toBe(true);
    expect(isTestFile("src/Demo.Core.Specs/Helpers.cs")).toBe(true);
    expect(isTestFile("src/Demo.Core/TokenService.cs")).toBe(false);
    expect(isTestFile("src/Demo.Core/Contests.cs")).toBe(true); // accepted over-match: ends in Tests.cs
    expect(isTestFile("src/Demo.Core/Attestation.cs")).toBe(false);
  });
```
`entry-points.test.ts`, new describe (uses the same temp-dir style as the Python cases):
```ts
import { csharpEntryReasons } from "../src/graph/entry-points.js";

describe("csharpEntryReasons", () => {
  function write(lines: string[]) {
    const root = mkdtempSync(join(tmpdir(), "srev-cs-entry-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "A.cs"), lines.join("\n"));
    return root;
  }
  it("detects controller actions by HTTP verb or Route attributes above the definition", () => {
    const root = write([
      "public class TokenController : ControllerBase",
      "{",
      '    [HttpGet("{userId}")]',
      "    [Authorize]",
      "    public ActionResult<string> Get(string userId) => Ok(userId);",
      "",
      '    [Route("x"), Authorize]',
      "    public IActionResult Route() => Ok();",
      "}",
    ]);
    expect(csharpEntryReasons(root, "src/A.cs", { label: "Get", startLine: 5 })).toEqual(["http-route"]);
    expect(csharpEntryReasons(root, "src/A.cs", { label: "Route", startLine: 8 })).toEqual(["http-route"]);
  });
  it("detects a static Main as a cli entry and stops scanning at non-attribute lines", () => {
    const root = write([
      "[ApiController]",
      "public class Program",
      "{",
      "    public static int Main(string[] args) => 0;",
      "    public void Helper() {}",
      "}",
    ]);
    expect(csharpEntryReasons(root, "src/A.cs", { label: "Main", startLine: 4 })).toEqual(["cli"]);
    expect(csharpEntryReasons(root, "src/A.cs", { label: "Helper", startLine: 5 })).toEqual([]);
  });
  it("returns [] for unreadable files and reuses the line cache", () => {
    expect(csharpEntryReasons("/nonexistent", "src/A.cs", { label: "X", startLine: 1 })).toEqual([]);
    const cache = new Map<string, string[]>([["src/A.cs", ["[HttpPost]", "public void Post() {}"]]]);
    expect(csharpEntryReasons("/nonexistent", "src/A.cs", { label: "Post", startLine: 2 }, cache)).toEqual(["http-route"]);
  });
});
```

- [x] **Step 2: Run to verify failure**

Run: `cd packages/server && pnpm exec vitest run test/util.test.ts test/entry-points.test.ts`
Expected: FAIL — `csharpEntryReasons` not exported; `TokenServiceTests.cs` outside a `tests/` dir is `false`.

- [x] **Step 3: Implement**

`util.ts` — add two alternatives to `isTestFile` and extend the doc comment ("C# `*Test(s).cs` / `*Spec(s).cs` files and `*.Tests/`-style project folders"):
```ts
  /(Tests?|Specs?)\.cs$/.test(p) ||
  /(^|\/)[^/]+\.(Tests?|Specs?)\//.test(p) ||
```

`entry-points.ts`:
```ts
/** Controller-action attributes (ASP.NET Core MVC / minimal attribute routing). */
const CS_ROUTE_ATTRIBUTE = /\[(?:[^\]]*,\s*)?(?:Http(?:Get|Post|Put|Delete|Patch|Head|Options)|Route|AcceptVerbs)\b/;

function cachedLines(root: string, file: string, cache?: Map<string, string[]>): string[] | undefined {
  const hit = cache?.get(file);
  if (hit) return hit;
  try {
    const lines = readFileSync(join(root, file), "utf8").split("\n");
    cache?.set(file, lines);
    return lines;
  } catch {
    return undefined;
  }
}

/**
 * Detected entry evidence for a C# definition: HTTP verb / Route attributes on
 * the lines directly above (or on) the definition line mark a controller
 * action; a `static … Main(` signature marks the program entry.
 */
export function csharpEntryReasons(
  root: string,
  file: string,
  node: { label: string; startLine: number },
  cache?: Map<string, string[]>,
): EntryReason[] {
  const lines = cachedLines(root, file, cache);
  if (!lines) return [];
  const reasons = new Set<EntryReason>();
  const def = lines[node.startLine - 1] ?? "";
  if (/\bstatic\b[^;{=]*\bMain\s*\(/.test(def)) reasons.add("cli");
  if (CS_ROUTE_ATTRIBUTE.test(def)) reasons.add("http-route");
  for (let i = node.startLine - 2; i >= 0; i--) {
    const t = (lines[i] ?? "").trim();
    if (!t.startsWith("[")) break;
    if (CS_ROUTE_ATTRIBUTE.test(t)) reasons.add("http-route");
  }
  return [...reasons];
}
```
Optionally refactor `pythonEntryReasons` to use `cachedLines` (behaviour-preserving; its tests cover it).

`scip.ts` `getFlows`: replace the inline `entryEvidence({...})` call with a helper so the Python branch and the new C# branch read the same way:
```ts
  /** Entry evidence for one graph root; `export` is a TS/JS concept and is never probed on Python or C# files. */
  private evidenceFor(
    sym: string,
    n: RawNode,
    sets: { roots: Set<string>; configured: Set<string> },
    fileCache: Map<string, string[]>,
  ) {
    const node = { label: n.label, startLine: n.startLine };
    const isPy = n.file.endsWith(".py");
    const isCs = n.file.endsWith(".cs");
    return entryEvidence({
      isRoot: sets.roots.has(sym),
      isExported: isPy || isCs ? false : isExportedAt(this.repoRoot, n.file, n.startLine, fileCache),
      isConfigured: sets.configured.has(sym),
      detected: isPy
        ? pythonEntryReasons(this.repoRoot, n.file, node, fileCache)
        : isCs
          ? csharpEntryReasons(this.repoRoot, n.file, node, fileCache)
          : [],
    });
  }
```
and in the `.map((sym, i) => …)`: `const evidence = this.evidenceFor(sym, n, { roots: rootSyms, configured: configuredSyms }, fileCache);`. Add `csharpEntryReasons` to the `./entry-points.js` import. (`RawNode` is the existing node type used by `buildGraphFromIndex`'s `nodes` map; if it is not exported/visible where needed, type the parameter as `{ label: string; file: string; startLine: number }`.)

- [x] **Step 4: Run tests and lint**

Run: `cd packages/server && pnpm exec vitest run && cd ../.. && pnpm lint | tail -1 && pnpm exec tsc --noEmit -p packages/server`
Expected: all server tests PASS; `0 blocking`; tsc clean.

- [x] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/server/src/util.ts packages/server/src/graph/entry-points.ts packages/server/src/graph/scip.ts packages/server/test/util.test.ts packages/server/test/entry-points.test.ts
git add packages/server/src packages/server/test
git commit -m "feat(scip): C# test-file and controller/Main entry heuristics" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Real scip-dotnet integration test

Slow, real-toolchain test mirroring `scip-java.test.ts`; skipped when scip-dotnet is unavailable. It exercises span synthesis, interface bridging and test attachment end-to-end.

**Files:**
- Test: `packages/server/test/scip-dotnet.test.ts` (append)

- [x] **Step 1: Write the test**

```ts
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

// Real scip-dotnet run over a two-project solution — slow (restore + Roslyn),
// so one test, skipped when the tool is not on this machine.
describe("scip-dotnet integration", () => {
  it.skipIf(!resolveScipDotnetCommand())(
    "indexes a solution and derives method-level flows through an injected interface",
    { timeout: 300_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "srev-cs-"));
      try {
        const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
        git("init", "-b", "main");
        git("config", "user.email", "t@t");
        git("config", "user.name", "t");
        const proj = (name: string, extra = "") =>
          `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n    <Nullable>enable</Nullable>\n    <ImplicitUsings>enable</ImplicitUsings>${extra}\n  </PropertyGroup>\n</Project>\n`;
        mkdirSync(join(dir, "src", "Demo.Core"), { recursive: true });
        mkdirSync(join(dir, "src", "Demo.App"), { recursive: true });
        writeFileSync(join(dir, "src", "Demo.Core", "Demo.Core.csproj"), proj("Demo.Core"));
        writeFileSync(
          join(dir, "src", "Demo.App", "Demo.App.csproj"),
          proj("Demo.App", "\n    <OutputType>Exe</OutputType>").replace(
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

        const prev = process.env.SCIP_LANGS;
        process.env.SCIP_LANGS = "cs";
        try {
          const provider = new ScipGraphProvider({ repoRoot: dir });
          const flows = await provider.getFlows();
          const main = flows.find((f) => f.name === "Main");
          expect(main, `expected a 'Main' flow, got: ${flows.map((f) => f.name).join(", ")}`).toBeDefined();
          const labels = main!.steps.map((s) => s.label);
          // Run → ITokenService.Resolve bridges to TokenService.Resolve → Mint.
          expect(labels).toEqual(expect.arrayContaining(["Main", "Run", "Resolve", "Mint"]));
          const mint = main!.steps.find((s) => s.label === "Mint")!;
          expect(mint.file).toBe("src/Demo.Core/TokenService.cs");
          expect(main!.evidence.reasons).toContain("cli");
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
```
If `Flow` exposes evidence under a different property name, read `packages/server/src/graph/provider.ts` for the `Flow` interface and adjust the last assertion to that name; do not drop it.

- [x] **Step 2: Run it with the tool available**

On the dev machine scip-dotnet is only installed as a local tool manifest in the spike scratchpad, so point the override at it (`dotnet tool run` needs that manifest's directory as cwd, which the provider does not control — use the tool's own binary instead):
```bash
dotnet tool install --global scip-dotnet --version 0.2.14   # one-time; asks nothing, lands in ~/.dotnet/tools
cd packages/server && pnpm exec vitest run test/scip-dotnet.test.ts
```
Expected: PASS including the integration case (roughly 10–30 s). If it is skipped, `resolveScipDotnetCommand()` did not find `~/.dotnet/tools/scip-dotnet`; check `HOME`.

- [x] **Step 3: Commit**

```bash
pnpm exec prettier --write packages/server/test/scip-dotnet.test.ts
git add packages/server/test/scip-dotnet.test.ts
git commit -m "test(scip): real scip-dotnet integration over a two-project solution" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Docs, plugin text, CI toolchain, bundles

**Files:**
- Modify: `AGENTS.md:75-78`, `README.md:16-18,182-186,197-198,206`, `docs/architecture.md:68-75`, `docs/cli-and-configuration.md:82-83`, `docs/harness.md:87`, `scripts/build-plugin.mjs:78-84`, `.claude-plugin/marketplace.json:11`, `.github/workflows/ci.yml:35-51`
- Regenerate: `plugin/`, `plugins/structured-review/` via `pnpm build && pnpm build:plugin`

- [x] **Step 1: Documentation text**

`AGENTS.md` (Graph providers paragraph):
> `GRAPH_PROVIDER=scip` is the default. It indexes the tracked working tree with scip-typescript, scip-python, and (when available) scip-java and scip-dotnet. A missing Java or .NET indexer toolchain is reported in `indexWarnings`; affected text changes remain reviewable as residuals. SCIP relationships are inferred from references and are not execution traces.

`README.md` line 16: "TypeScript/JavaScript, Python, Java and C# are supported, with limitations below."
Language table: add `| C# | scip-dotnet (\`dotnet tool install --global scip-dotnet\`); requires the .NET SDK 8 or newer |`.
Line 186 paragraph: "Missing Java or C# tooling produces a visible warning and a text-only review of the affected changes. Install the tools and recreate the session for call relationships. scip-dotnet does not fail on compile errors; a broken C# build yields a partial index and more residuals rather than an error."
Line 197: "Java and C# indexing run the project's build or restore (including build plugins and NuGet restore); indexing is not sandboxed."
Line 206: "Indexer installation downloads packages, and Java or .NET tooling may download build dependencies."

`docs/architecture.md`: change "TypeScript/JavaScript, Python, and Java use separate indexers" to "TypeScript/JavaScript, Python, Java, and C# use separate indexers", and after the Java paragraph add:
> C# indexing runs scip-dotnet over the root's solution file (or single project file) and lets it restore packages. scip-dotnet emits no enclosing ranges, so the provider derives method body spans from source before building the graph; properties, fields and events never become nodes. scip-dotnet exits successfully even when the build has compile errors, so a broken C# build produces a partial index rather than an indexing error; only a missing tool (warning) or a non-zero exit / empty index (error) are signalled.

`docs/cli-and-configuration.md` env table, after `SCIP_JAVA_VERSION`:
```
| `SCIP_DOTNET_CMD` | unset | (scip) Explicit scip-dotnet launcher, overriding PATH and `~/.dotnet/tools` detection. |
| `SCIP_DOTNET_SOLUTION` | unset | (scip) Solution or project file to index when a C# root holds several; relative to that root. |
| `SCIP_LANGS` | `ts,py,java,cs` | (scip) Comma-separated indexer languages to enable. |
```

`docs/harness.md` line 87: "The separately downloaded SCIP Java/Maven/Coursier toolchain and the .NET SDK / scip-dotnet tool also sit outside the pnpm advisory inventory."

`scripts/build-plugin.mjs` `LANGUAGE_SUPPORT`: after the Java sentence add "C# needs scip-dotnet (`dotnet tool install --global scip-dotnet`, .NET SDK 8+) on PATH or in `~/.dotnet/tools`; without it C# changes appear as residual-only with the same kind of warning."

`.claude-plugin/marketplace.json` description: "… TS/Python bundled; Java via scip-java toolchain on PATH; C# via scip-dotnet."

- [x] **Step 2: CI toolchain (`ci.yml`)**

After the "Install Coursier" step:
```yaml
      - name: Install .NET SDK
        uses: actions/setup-dotnet@a98b56852c35b8e3190ac28c8c2271da59106c68 # v6.0.0
        with:
          dotnet-version: 8.0.x

      - name: Install scip-dotnet
        run: dotnet tool install --global scip-dotnet --version 0.2.14
```
Extend "Verify real indexer toolchains":
```yaml
          dotnet --version
          "$HOME/.dotnet/tools/scip-dotnet" --version
```
Update the comment above Coursier to mention that the .NET SDK and scip-dotnet keep the real scip-dotnet integration enabled.

- [x] **Step 3: Rebuild bundles and run the full gate**

```bash
pnpm build && pnpm build:plugin && pnpm verify
```
Expected: all 11 steps exit 0 (typecheck, format, lint, architecture, build, test:coverage, coverage:check, plugin:check, test:e2e, security:check, security:probe). Fix any coverage shortfall on the new files by adding the missing test case, not by touching baselines.

- [x] **Step 4: Commit**

```bash
pnpm exec prettier --write AGENTS.md README.md docs/architecture.md docs/cli-and-configuration.md docs/harness.md
git add -A
git commit -m "docs,ci: C# support — toolchain setup, configuration, plugin text, CI scip-dotnet" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Finish the branch

- [ ] Rebase onto `main`, fast-forward merge, rerun `pnpm test` on the merged result, push, delete the branch (see memory `git-workflow-rebase-ff`). Bump `plugin/.claude-plugin/plugin.json` to `0.12.0` before merging (the Codex manifest regenerates from it; rebuild bundles after the bump).
- [ ] Watch the CI run for the merged commit; confirm the scip-dotnet integration test ran (not skipped) by checking the job log for `scip: cs root`.

### Deferred from the spec

- Namespace-collision warning (a definition symbol seen in two files): not implemented in this plan. scip-dotnet keeps only the last namespace segment, so two `Models/Order#` types would merge into one node set. Revisit if dogfood shows real collisions.
