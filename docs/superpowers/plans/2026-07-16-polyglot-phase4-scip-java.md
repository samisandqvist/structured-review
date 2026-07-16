# Polyglot Phase 4 — scip-java Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Java changes produce call-graph flows: run scip-java per Maven/Gradle root on the Phase 1 multi-index orchestration, with the two decoder deltas the Phase 3 spike identified, and per-language degradation (visible warning, never silent) when the Java toolchain is missing.

**Architecture:** All decoder/orchestration changes live in `packages/server/src/graph/scip.ts` + `roots.ts`, mirroring how ts/py jobs work. scip-java is an external JVM tool resolved at runtime (env override → `scip-java` on PATH → coursier `cs launch` with pinned coordinates); when unresolvable, Java jobs are dropped with a warning that flows through a new optional `GraphProvider.getIndexWarnings()` into the session row (schema v5), the session API, and a PlanView banner — the roadmap's "minimal session diagnostics". Spike findings doc: `docs/scip-java-spike-findings.md` (gate PASSED; read it for the empirical basis of every decoder change here).

**Tech Stack:** TypeScript (Node ESM), vitest, protobufjs + scip.proto (existing), scip-java 0.12.3 via coursier, better-sqlite3 migrations, React (banner only).

## Global Constraints

- Package manager: **pnpm** (never npm).
- Server tests: `pnpm -C packages/server exec vitest run <file>`; full suite `pnpm -C packages/server test`; typecheck `pnpm -C packages/server typecheck`. Web: `pnpm -C packages/web typecheck`.
- Branch: `feat/polyglot-phase4` off `main`. Rebase + ff-only merge workflow (no merge commits).
- TDD: failing test first for every behavioral change (Task 2's integration test is guarded by `skipIf` — the resolver unit tests are its TDD surface).
- Never-stale cache rule: any git/toolchain failure must produce a cache miss or a loud error — never a silent stale hit.
- Degradation rule (release-blocking for the plugin): missing Java toolchain must NEVER fail or silently degrade a session — Java jobs drop with a warning the reviewer can see; a broken Java *build* (toolchain present, compile fails) stays a loud `IndexError` like every other indexer failure.
- scip-java coordinates, pinned: `com.sourcegraph:scip-java_2.13:0.12.3`, main class `com.sourcegraph.scip_java.ScipJava`. `cs install scip-java` does NOT work (not in coursier's default app channel) — never emit it in user-facing messages.
- The two decoder deltas from the spike are Java-scoped: TS/Python node derivation and labels must be byte-for-byte unchanged (existing tests prove it).

---

### Task 1: Decoder deltas — Java node filter + labelOf generalization

**Files:**
- Modify: `packages/server/src/graph/scip.ts:395-399` (`labelOf`), `:406-423` (node loop in `buildGraphFromIndex`)
- Test: `packages/server/test/scip-multi.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `buildGraphFromIndex` (same signature) now — for documents whose path ends `.java` only — keeps a definition as a node only when its symbol ends with a method descriptor (`).`); `labelOf` (module-private) strips any `(…).` suffix (covers `().` and overload disambiguators `(+N).`) and labels Java constructors (`` `<init>` ``) with their class name. Task 2's integration test relies on both.

**Spike facts driving this task:** scip-java attaches `enclosingRange` to field/enum defs too (670 of them on the probe repo — noise nodes + field-read noise edges without the filter), and 81 constructor/overload symbols made `labelOf` return null (dropped silently).

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/test/scip-multi.test.ts`:

```ts
describe("java symbol shapes (spike deltas)", () => {
  const J = "semanticdb maven maven/fi.pareto/demo 1.0.0 ";
  const J_RUN = `${J}demo/App#run().`;
  const J_OVERLOAD = `${J}demo/App#run(+1).`;
  const J_CTOR = "semanticdb maven maven/fi.pareto/demo 1.0.0 demo/App#`<init>`().";
  const J_FIELD = `${J}demo/App#svc.`;
  const J_GREET = `${J}demo/Svc#greet().`;

  const javaDocs: ScipDocument[] = [
    {
      relativePath: "src/main/java/demo/App.java",
      occurrences: [
        // scip-java gives ALL of these an enclosingRange — fields included.
        { symbol: J_CTOR, symbolRoles: 1, range: [2, 9, 12], enclosingRange: [2, 2, 4, 3] },
        { symbol: J_RUN, symbolRoles: 1, range: [5, 16, 19], enclosingRange: [5, 2, 7, 3] },
        { symbol: J_OVERLOAD, symbolRoles: 1, range: [8, 16, 19], enclosingRange: [8, 2, 10, 3] },
        { symbol: J_FIELD, symbolRoles: 1, range: [1, 20, 23], enclosingRange: [1, 2, 1, 30] },
        { symbol: J_FIELD, symbolRoles: 0, range: [6, 4, 7] },  // run() reads the field
        { symbol: J_GREET, symbolRoles: 0, range: [6, 8, 13] }, // run() calls Svc#greet()
      ],
    },
    {
      relativePath: "src/main/java/demo/Svc.java",
      occurrences: [{ symbol: J_GREET, symbolRoles: 1, range: [1, 16, 21], enclosingRange: [1, 2, 3, 3] }],
    },
  ];

  it("keeps only method-descriptor symbols as nodes in .java documents", () => {
    const g = buildGraphFromIndex({ documents: javaDocs }, "/repo");
    expect(g.nodes.has(J_RUN)).toBe(true);
    expect(g.nodes.has(J_GREET)).toBe(true);
    expect(g.nodes.has(J_FIELD)).toBe(false); // field def carries enclosingRange but is not a node
  });

  it("keeps overloads ((+N). descriptors) and labels them", () => {
    const g = buildGraphFromIndex({ documents: javaDocs }, "/repo");
    expect(g.nodes.get(J_OVERLOAD)?.label).toBe("run");
  });

  it("labels constructors with the class name", () => {
    const g = buildGraphFromIndex({ documents: javaDocs }, "/repo");
    expect(g.nodes.get(J_CTOR)?.label).toBe("App");
  });

  it("derives method-level call edges and no field-read edges", () => {
    const g = buildGraphFromIndex({ documents: javaDocs }, "/repo");
    expect(g.callAdj.get(J_RUN)).toEqual([J_GREET]);
  });

  it("does not apply the java node filter to non-java documents", () => {
    // A python term-shaped symbol with enclosingRange must still be dropped or
    // kept exactly as before this change: the ts/py fixtures above prove
    // labels/nodes are unchanged, this pins the filter's file scoping.
    const tsDoc: ScipDocument[] = [{
      relativePath: "src/a.ts",
      occurrences: [{ symbol: TS_MAIN, symbolRoles: 1, range: [0, 9, 10], enclosingRange: [0, 0, 4, 1] }],
    }];
    const g = buildGraphFromIndex({ documents: tsDoc }, "/repo");
    expect(g.nodes.has(TS_MAIN)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C packages/server exec vitest run test/scip-multi.test.ts`
Expected: FAIL — `J_FIELD` currently becomes a node (has enclosingRange); `J_OVERLOAD` and `J_CTOR` get `label` null and are absent; `callAdj.get(J_RUN)` contains the field symbol.

- [ ] **Step 3: Implement both deltas**

In `packages/server/src/graph/scip.ts`, replace `labelOf`:

```ts
function labelOf(symbol: string): string | null {
  // Strip any method descriptor suffix: `().` and java overloads `(+N).`.
  const s = symbol.replace(/\([^)]*\)\.$/, "").replace(/[.#/]+$/, "");
  // Java constructors (`Cls#`<init>``): label with the class name.
  const ctor = s.match(/([A-Za-z0-9_$]+)#`<init>`$/);
  if (ctor) return ctor[1];
  const m = s.match(/([A-Za-z0-9_$]+)`?$/);
  return m ? m[1] : null;
}
```

In the node loop of `buildGraphFromIndex`, after the existing `if (/[#/]$/.test(o.symbol)) continue;` line, add:

```ts
      // scip-java attaches enclosingRange to fields/enum constants too (TS and
      // Python indexers only give it to callables): in Java documents, only a
      // method descriptor (`…(...).`) is a graph node.
      if (file.endsWith(".java") && !/\)\.$/.test(o.symbol)) continue;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C packages/server exec vitest run test/scip-multi.test.ts`
Expected: PASS — including all pre-existing ts/py symbol tests (labels unchanged: `\([^)]*\)\.$` strips exactly what `\(\)\.$` stripped on `().` symbols).

- [ ] **Step 5: Full suite + typecheck, then commit**

Run: `pnpm -C packages/server test && pnpm -C packages/server typecheck`
Expected: PASS (python/ts label lock-in tests from Phase 2 prove no drift).

```bash
git add packages/server/src/graph/scip.ts packages/server/test/scip-multi.test.ts
git commit -m "feat(server): java decoder deltas — method-descriptor node filter, overload/ctor labels"
```

---

### Task 2: scip-java resolver + Java indexer job

**Files:**
- Modify: `packages/server/src/graph/scip.ts` (resolver near the top-level helpers; `runIndexer` java branch at `:301-311`)
- Modify: `packages/server/src/graph/roots.ts` (java `FINGERPRINT_EXTRAS`)
- Test: `packages/server/test/scip-java.test.ts` (create)
- Test: `packages/server/test/roots.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's decoder deltas (the integration test asserts labels/edges that need them).
- Produces:
  - `interface ScipJavaCommand { argv0: string; args: string[] }` and `resolveScipJavaCommand(env: NodeJS.ProcessEnv = process.env): ScipJavaCommand | null`, exported from `graph/scip.ts`. Resolution order: `SCIP_JAVA_CMD` (whitespace-split command prefix) → `scip-java` executable on PATH → `cs` on PATH launching `com.sourcegraph:scip-java_2.13:${SCIP_JAVA_VERSION ?? "0.12.3"}`. Null = unavailable. Task 3's degradation depends on this exact export.
  - `runIndexer` handles `job.language === "java"`.
  - Java stays opt-in this task (`SCIP_LANGS` default still `ts,py`) — Task 3 flips the default together with degradation, so no intermediate state where a missing JVM breaks ts/py sessions.

- [ ] **Step 1: Write the failing resolver unit tests**

Create `packages/server/test/scip-java.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScipGraphProvider, resolveScipJavaCommand } from "../src/graph/scip.js";

describe("resolveScipJavaCommand", () => {
  it("honors the SCIP_JAVA_CMD override verbatim", () => {
    expect(resolveScipJavaCommand({ SCIP_JAVA_CMD: "scip-java" }))
      .toEqual({ argv0: "scip-java", args: [] });
    expect(resolveScipJavaCommand({ SCIP_JAVA_CMD: "cs launch foo --" }))
      .toEqual({ argv0: "cs", args: ["launch", "foo", "--"] });
  });

  it("finds a scip-java executable on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "crw-sj-path-"));
    writeFileSync(join(dir, "scip-java"), "#!/bin/sh\n", { mode: 0o755 });
    expect(resolveScipJavaCommand({ PATH: dir })).toEqual({ argv0: "scip-java", args: [] });
  });

  it("falls back to coursier launch with pinned (or overridden) coordinates", () => {
    const dir = mkdtempSync(join(tmpdir(), "crw-sj-cs-"));
    writeFileSync(join(dir, "cs"), "#!/bin/sh\n", { mode: 0o755 });
    expect(resolveScipJavaCommand({ PATH: dir, SCIP_JAVA_VERSION: "9.9.9" })).toEqual({
      argv0: "cs",
      args: ["launch", "com.sourcegraph:scip-java_2.13:9.9.9", "-M", "com.sourcegraph.scip_java.ScipJava", "--"],
    });
  });

  it("returns null when nothing is available", () => {
    expect(resolveScipJavaCommand({ PATH: "/nonexistent" })).toBeNull();
    expect(resolveScipJavaCommand({})).toBeNull();
  });

  it("prefers scip-java over cs when both are present", () => {
    const dir = mkdtempSync(join(tmpdir(), "crw-sj-both-"));
    writeFileSync(join(dir, "scip-java"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(dir, "cs"), "#!/bin/sh\n", { mode: 0o755 });
    expect(resolveScipJavaCommand({ PATH: dir })!.argv0).toBe("scip-java");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C packages/server exec vitest run test/scip-java.test.ts`
Expected: FAIL — `resolveScipJavaCommand` is not exported.

- [ ] **Step 3: Implement the resolver**

In `packages/server/src/graph/scip.ts` — extend the `node:fs` import with `accessSync, constants as fsConstants`, then add near `resolveIndexerBin`:

```ts
const SCIP_JAVA_DEFAULT_VERSION = "0.12.3";

export interface ScipJavaCommand { argv0: string; args: string[] }

/**
 * Locate a way to run scip-java (a JVM tool we cannot bundle): SCIP_JAVA_CMD
 * override, a `scip-java` launcher on PATH, or coursier (`cs`) launching the
 * pinned coordinates. Null = unavailable — callers must degrade Java jobs
 * with a visible warning, never silently. NOTE: `cs install scip-java` does
 * not exist in coursier's default channel; only the launch-by-coordinates
 * form is reliable.
 */
export function resolveScipJavaCommand(env: NodeJS.ProcessEnv = process.env): ScipJavaCommand | null {
  const override = env.SCIP_JAVA_CMD?.trim();
  if (override) {
    const [argv0, ...args] = override.split(/\s+/);
    return { argv0, args };
  }
  if (findOnPath("scip-java", env)) return { argv0: "scip-java", args: [] };
  if (findOnPath("cs", env)) {
    const version = env.SCIP_JAVA_VERSION ?? SCIP_JAVA_DEFAULT_VERSION;
    return {
      argv0: "cs",
      args: ["launch", `com.sourcegraph:scip-java_2.13:${version}`, "-M", "com.sourcegraph.scip_java.ScipJava", "--"],
    };
  }
  return null;
}

function findOnPath(bin: string, env: NodeJS.ProcessEnv): boolean {
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

Run: `pnpm -C packages/server exec vitest run test/scip-java.test.ts` — resolver tests PASS.

- [ ] **Step 4: Add the java branch to `runIndexer`**

In `runIndexer` (`scip.ts`), between the `py` branch and the final `else`:

```ts
        } else if (job.language === "java") {
          const cmd = resolveScipJavaCommand();
          if (!cmd) {
            throw new IndexError(
              `scip-java toolchain not found for root '${job.root || "."}': install coursier ('cs') plus a JDK and Maven, or set SCIP_JAVA_CMD`
            );
          }
          execFileSync(cmd.argv0, [...cmd.args, "index", "--output", indexPath], {
            cwd: absRoot,
            encoding: "utf8",
            maxBuffer: 256 * 1024 * 1024,
          });
        } else {
```

(The generic catch below already wraps non-zero exits into `IndexError` with a stderr tail — the spike confirmed scip-java exits 1 with a clear javac error and writes no index file on a broken build, so no additional handling is needed.)

- [ ] **Step 5: Write the failing integration test**

Append to `packages/server/test/scip-java.test.ts`:

```ts
// Real scip-java run over a tiny Maven fixture — slow (JVM + mvn compile),
// so one test, skipped when no Java toolchain is on this machine.
describe("scip-java integration", () => {
  it.skipIf(!resolveScipJavaCommand())(
    "indexes a maven root and derives method-level flows",
    { timeout: 300_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "crw-java-"));
      try {
        const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
        git("init", "-b", "main");
        git("config", "user.email", "t@t");
        git("config", "user.name", "t");
        mkdirSync(join(dir, "svc", "src", "main", "java", "demo"), { recursive: true });
        writeFileSync(
          join(dir, "svc", "pom.xml"),
          `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>demo</groupId><artifactId>svc</artifactId><version>0.1.0</version>
  <properties><maven.compiler.source>17</maven.compiler.source><maven.compiler.target>17</maven.compiler.target></properties>
</project>
`
        );
        writeFileSync(
          join(dir, "svc", "src", "main", "java", "demo", "Svc.java"),
          "package demo;\npublic class Svc {\n  public String greet(String name) { return \"hello \" + name; }\n}\n"
        );
        writeFileSync(
          join(dir, "svc", "src", "main", "java", "demo", "App.java"),
          "package demo;\npublic class App {\n  public String run() { return new Svc().greet(\"world\"); }\n  public static void main(String[] args) { System.out.println(new App().run()); }\n}\n"
        );
        git("add", ".");
        git("commit", "-m", "init");

        process.env.SCIP_LANGS = "java";
        const provider = new ScipGraphProvider({ repoRoot: dir });
        const flows = await provider.getFlows();
        const main = flows.find((f) => f.name === "main");
        expect(main, `expected a 'main' flow, got: ${flows.map((f) => f.name).join(", ")}`).toBeDefined();
        const labels = main!.steps.map((s) => s.label);
        expect(labels).toEqual(expect.arrayContaining(["main", "run", "greet"]));
        const greet = main!.steps.find((s) => s.label === "greet")!;
        expect(greet.file).toBe("svc/src/main/java/demo/Svc.java");
      } finally {
        delete process.env.SCIP_LANGS;
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
```

- [ ] **Step 6: Run the integration test**

Run: `pnpm -C packages/server exec vitest run test/scip-java.test.ts`
Expected: PASS on this machine (coursier is installed at `~/.local/bin/cs`; first run may download Maven deps — the 300 s timeout covers it). If the environment truly lacks a toolchain the test reports SKIP — that is acceptable for CI but on this machine it must RUN; if it skips here, stop and report (the toolchain install regressed).

- [ ] **Step 7: Java fingerprint extras**

In `packages/server/test/roots.test.ts`, add inside `describe("languagePathspecs")`:

```ts
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
```

Run it (FAIL: java extras are `[]`), then in `packages/server/src/graph/roots.ts` replace the java entry of `FINGERPRINT_EXTRAS`:

```ts
  java: [
    "settings.gradle",
    "settings.gradle.kts",
    "gradle.properties",
    "gradle.lockfile",
    "maven-wrapper.properties",
    "settings.xml",
  ],
```

Run: `pnpm -C packages/server exec vitest run test/roots.test.ts` — PASS.

- [ ] **Step 8: Full suite + typecheck, then commit**

Run: `pnpm -C packages/server test && pnpm -C packages/server typecheck`
Expected: PASS. Java is still opt-in (`SCIP_LANGS` default unchanged this task), so no existing test's environment changes.

```bash
git add packages/server/src/graph/scip.ts packages/server/src/graph/roots.ts packages/server/test/scip-java.test.ts packages/server/test/roots.test.ts
git commit -m "feat(server): scip-java indexer job with toolchain resolver and fingerprint extras"
```

---

### Task 3: Per-language degradation + session index diagnostics

**Files:**
- Modify: `packages/server/src/graph/scip.ts` (`discoverJobs` default, new `planJobs`, `indexAndBuild`, `BuiltGraph`, `getIndexWarnings`)
- Modify: `packages/server/src/graph/provider.ts` (optional interface method)
- Modify: `packages/server/src/db/schema.ts` (migration 5), `packages/server/src/repo/sessions.ts`, `packages/server/src/types.ts`
- Modify: `packages/server/src/routes/sessions.ts:112-141` (persist + return warnings)
- Modify: `packages/web/src/api/client.ts:1-4` (`ReviewSession`), `packages/web/src/components/PlanView.tsx` (banner)
- Test: `packages/server/test/scip-java.test.ts`, `packages/server/test/scip-cache.test.ts`, `packages/server/test/schema.test.ts`, `packages/server/test/routes.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveScipJavaCommand` from Task 2 (exact export name).
- Produces:
  - `BuiltGraph` gains `warnings?: string[]`.
  - `ScipGraphProvider` gains `protected resolveJavaCommand(): ScipJavaCommand | null` (test seam), `protected planJobs(): { jobs: IndexerJob[]; warnings: string[] }`, and `async getIndexWarnings(): Promise<string[]>`.
  - `GraphProvider` interface gains optional `getIndexWarnings?(): Promise<string[]>`.
  - `SCIP_LANGS` default becomes `"ts,py,java"`.
  - Schema v5: `review_sessions.index_warnings TEXT NOT NULL DEFAULT '[]'`; `ReviewSession.indexWarnings: string[]` on server and (optional) web.
  - `createSession(db, branch, baseRef, headSha = "", repoFingerprint = "", indexWarnings: string[] = [])`.

- [ ] **Step 1: Write the failing provider degradation tests**

Append to `packages/server/test/scip-java.test.ts` (extend the top import with `type ScipJavaCommand` and `type BuiltGraph`; import `type IndexerJob` from `../src/graph/roots.js`):

```ts
describe("java degradation (planJobs)", () => {
  const JOBS: IndexerJob[] = [
    { language: "ts", root: "", hasSources: true },
    { language: "java", root: "introspector", hasSources: true },
    { language: "py", root: "mcp/svc", hasSources: true },
  ];
  class Probe extends ScipGraphProvider {
    java: ScipJavaCommand | null = null;
    protected override discoverJobs(): IndexerJob[] { return JOBS; }
    protected override resolveJavaCommand(): ScipJavaCommand | null { return this.java; }
    plan() { return this.planJobs(); }
  }

  it("drops java jobs with a visible warning when the toolchain is missing", () => {
    const p = new Probe({ repoRoot: "/tmp" });
    const { jobs, warnings } = p.plan();
    expect(jobs.map((j) => j.language)).toEqual(["ts", "py"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Java indexing skipped/);
    expect(warnings[0]).toMatch(/'introspector'/);
    expect(warnings[0]).toMatch(/cs launch com\.sourcegraph:scip-java/);
    expect(warnings[0]).toMatch(/SCIP_JAVA_CMD/);
  });

  it("keeps java jobs and emits no warning when the toolchain resolves", () => {
    const p = new Probe({ repoRoot: "/tmp" });
    p.java = { argv0: "scip-java", args: [] };
    const { jobs, warnings } = p.plan();
    expect(jobs.map((j) => j.language)).toEqual(["ts", "java", "py"]);
    expect(warnings).toEqual([]);
  });

  it("emits no warning when no java roots exist", () => {
    class NoJava extends Probe {
      protected override discoverJobs(): IndexerJob[] { return JOBS.filter((j) => j.language !== "java"); }
    }
    const p = new NoJava({ repoRoot: "/tmp" });
    expect(p.plan().warnings).toEqual([]);
  });
});
```

And append to `packages/server/test/scip-cache.test.ts` inside the existing describe (FakeProvider pattern is at the top of that file):

```ts
  it("exposes the build's warnings via getIndexWarnings", async () => {
    class WarnProvider extends FakeProvider {
      protected override indexAndBuild(): Promise<BuiltGraph> {
        this.builds++;
        return Promise.resolve({ ...EMPTY, warnings: ["Java indexing skipped for 1 root(s)"] });
      }
    }
    const p = new WarnProvider({ repoRoot: "/tmp" });
    expect(await p.getIndexWarnings()).toEqual(["Java indexing skipped for 1 root(s)"]);
    await p.getNeighbors("x");
    expect(p.builds).toBe(1); // warnings ride the same cached build
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C packages/server exec vitest run test/scip-java.test.ts test/scip-cache.test.ts`
Expected: FAIL — `resolveJavaCommand`/`planJobs`/`getIndexWarnings` don't exist; `warnings` not on `BuiltGraph`.

- [ ] **Step 3: Implement provider-side degradation**

In `packages/server/src/graph/scip.ts`:

Add `warnings?: string[]` to `BuiltGraph`:

```ts
export interface BuiltGraph {
  nodes: Map<string, RawNode>; // symbol -> node
  callAdj: Map<string, string[]>; // caller -> callees (deduped)
  callRev: Map<string, string[]>; // callee -> callers
  /** Per-language degradation notices from job planning (e.g. java toolchain missing). */
  warnings?: string[];
}
```

Change the `discoverJobs` default from `"ts,py"` to `"ts,py,java"` (same line, `scip.ts:242`).

Add to the `ScipGraphProvider` class:

```ts
  /** Test seam over the module-level resolver. */
  protected resolveJavaCommand(): ScipJavaCommand | null {
    return resolveScipJavaCommand();
  }

  /**
   * Jobs to actually run plus degradation warnings. A missing Java toolchain
   * must not fail (or silently hollow out) a ts/py session: java jobs drop
   * with a warning that surfaces in session diagnostics; their files stay
   * visible as residual-only changes. A present-but-failing toolchain is NOT
   * handled here — runIndexer throws IndexError loudly for that.
   */
  protected planJobs(): { jobs: IndexerJob[]; warnings: string[] } {
    const jobs = this.discoverJobs();
    const javaJobs = jobs.filter((j) => j.language === "java");
    if (javaJobs.length === 0 || this.resolveJavaCommand()) return { jobs, warnings: [] };
    const roots = javaJobs.map((j) => `'${j.root || "."}'`).join(", ");
    return {
      jobs: jobs.filter((j) => j.language !== "java"),
      warnings: [
        `Java indexing skipped for ${javaJobs.length} root(s) (${roots}): scip-java toolchain not found. ` +
          `Install coursier ('cs') plus a JDK and Maven (scip-java runs via ` +
          `'cs launch com.sourcegraph:scip-java_2.13:${SCIP_JAVA_DEFAULT_VERSION} -M com.sourcegraph.scip_java.ScipJava -- index'), ` +
          `or set SCIP_JAVA_CMD. Java changes appear as residual-only until then.`,
      ],
    };
  }

  /** Degradation notices for the current (cached) build — [] when none. */
  async getIndexWarnings(): Promise<string[]> {
    return (await this.buildGraph()).warnings ?? [];
  }
```

Rework `indexAndBuild` to use `planJobs` and attach warnings:

```ts
  /** Run every enabled indexer job (each cached per subtree) and merge the documents. */
  protected async indexAndBuild(): Promise<BuiltGraph> {
    this.proto ??= await protobuf.load(SCIP_PROTO);
    const { jobs, warnings } = this.planJobs();
    const perJob = await Promise.all(jobs.map((j) => this.jobDocuments(j)));
    const g = buildGraphFromIndex({ documents: perJob.flat() }, this.repoRoot);
    if (warnings.length) {
      for (const w of warnings) console.warn(`scip: ${w}`);
      g.warnings = warnings;
    }
    return g;
  }
```

In `packages/server/src/graph/provider.ts`, add to the `GraphProvider` interface:

```ts
  /** Optional: per-language indexing degradation notices for the current build
   *  (e.g. "Java indexing skipped: toolchain missing"). Absent/[] = none. */
  getIndexWarnings?(): Promise<string[]>;
```

Run: `pnpm -C packages/server exec vitest run test/scip-java.test.ts test/scip-cache.test.ts` — PASS.

- [ ] **Step 4: Write the failing schema + route tests**

Append to `packages/server/test/schema.test.ts` (follow the v3 test pattern at its line 74):

```ts
  it("adds review_sessions.index_warnings via the v5 migration, '[]' for existing rows", () => {
    const db = new Database(":memory:");
    for (const v of [1, 2, 3, 4]) db.exec(MIGRATIONS[v]);
    db.prepare(
      "INSERT INTO review_sessions (id, branch, base_ref, status, created_at, head_sha) VALUES ('s1', 'b', 'main', 'planning', 0, '')"
    ).run();
    db.exec(MIGRATIONS[5]);
    const row = db.prepare("SELECT index_warnings FROM review_sessions WHERE id = 's1'").get() as { index_warnings: string };
    expect(row.index_warnings).toBe("[]");
  });
```

(Match the actual import/naming conventions at the top of `schema.test.ts` — it already imports `MIGRATIONS` and better-sqlite3.)

Append to `packages/server/test/routes.test.ts`, in the `describe("POST /api/sessions", …)` block:

```ts
  it("persists and returns index warnings from the graph provider", async () => {
    const warning = "Java indexing skipped for 1 root(s) ('introspector'): scip-java toolchain not found.";
    const stub = new StubGraphProvider() as StubGraphProvider & { getIndexWarnings(): Promise<string[]> };
    stub.getIndexWarnings = async () => [warning];
    const warnApp = createApp({ db, graphProvider: stub, repoRoot: fixtureRoot });
    const cr = await warnApp.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    expect(cr.status).toBe(200);
    const { session } = await cr.json();
    expect(session.indexWarnings).toEqual([warning]);
    const res = await warnApp.request(`/api/sessions/${session.id}`);
    const body = await res.json();
    expect(body.session.indexWarnings).toEqual([warning]);
  });

  it("returns empty index warnings when the provider reports none", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    expect(session.indexWarnings).toEqual([]);
  });
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `pnpm -C packages/server exec vitest run test/schema.test.ts test/routes.test.ts`
Expected: FAIL — no migration 5; `session.indexWarnings` undefined.

- [ ] **Step 6: Implement schema + repo + route**

`packages/server/src/db/schema.ts`: bump `SCHEMA_VERSION` to `5` and add:

```ts
  5: `ALTER TABLE review_sessions ADD COLUMN index_warnings TEXT NOT NULL DEFAULT '[]';`,
```

`packages/server/src/types.ts` — add to `ReviewSession`:

```ts
  /** Per-language indexing degradation notices captured at session creation. */
  indexWarnings: string[];
```

`packages/server/src/repo/sessions.ts` — replace `createSession` and `getSession`:

```ts
export function createSession(
  db: DB,
  branch: string,
  baseRef: string,
  headSha = "",
  repoFingerprint = "",
  indexWarnings: string[] = []
): ReviewSession {
  const id = randomId("ses");
  const createdAt = Date.now();
  db.prepare(
    "INSERT INTO review_sessions (id, branch, base_ref, status, created_at, head_sha, repo_fingerprint, index_warnings) VALUES (?, ?, ?, 'planning', ?, ?, ?, ?)"
  ).run(id, branch, baseRef, createdAt, headSha, repoFingerprint, JSON.stringify(indexWarnings));
  return { id, branch, baseRef, status: "planning", createdAt, headSha, repoFingerprint, indexWarnings };
}

export function getSession(db: DB, id: string): ReviewSession | undefined {
  const row = db.prepare("SELECT * FROM review_sessions WHERE id = ?").get(id) as
    | { id: string; branch: string; base_ref: string; status: SessionStatus; created_at: number; head_sha: string; repo_fingerprint: string; index_warnings: string }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id, branch: row.branch, baseRef: row.base_ref, status: row.status,
    createdAt: row.created_at, headSha: row.head_sha, repoFingerprint: row.repo_fingerprint,
    indexWarnings: JSON.parse(row.index_warnings) as string[],
  };
}
```

`packages/server/src/routes/sessions.ts` — inside the existing try block (after the `residuals = …` line), fetch warnings; then pass them to `createSession`:

```ts
      residuals = computeResiduals(body.baseRef, spansByFile, ctx.repoRoot!);
      indexWarnings = (await ctx.graphProvider.getIndexWarnings?.()) ?? [];
```

with the declaration alongside its peers above the try:

```ts
    let indexWarnings: string[] = [];
```

and:

```ts
      const session = createSession(ctx.db, body.branch, body.baseRef, headSha, repoFingerprint(ctx.repoRoot) ?? "", indexWarnings);
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm -C packages/server exec vitest run test/schema.test.ts test/routes.test.ts test/repo.test.ts`
Expected: PASS (the GET path needs no change — `getSession` now carries the field through the existing `c.json({ session, … })`). If `repo.test.ts` asserts full-session object equality, extend those expected objects with `indexWarnings: []` — that is the only legitimate test edit; do not weaken assertions.

- [ ] **Step 8: Web banner**

`packages/web/src/api/client.ts` — add to its `ReviewSession`:

```ts
  indexWarnings?: string[];
```

`packages/web/src/components/PlanView.tsx` — directly after the `<div style={head}>…</div>` element in the non-empty return, insert:

```tsx
      {(sessionData?.session?.indexWarnings?.length ?? 0) > 0 && (
        <div style={warnBanner}>
          {sessionData!.session.indexWarnings!.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}
```

and add a `warnBanner` style const next to the file's existing style consts (`wrap`, `head`, `empty` — mirror their exact typing convention):

```ts
const warnBanner = {
  margin: "8px 16px 0",
  padding: "8px 12px",
  borderRadius: 6,
  background: "rgba(230, 160, 30, 0.12)",
  border: "1px solid rgba(230, 160, 30, 0.35)",
  fontSize: 13,
  lineHeight: 1.5,
};
```

Note: `useSession`'s GET payload includes `session` (see `client.ts:100`) — if the `PlanView` destructuring only uses `units` today, `sessionData?.session` is already present in the payload type; extend the `fetchJson` type parameter at `client.ts:100` only if `session` is missing from it.

Run: `pnpm -C packages/web typecheck`
Expected: clean.

- [ ] **Step 9: Full suite + typecheck, then commit**

Run: `pnpm -C packages/server test && pnpm -C packages/server typecheck && pnpm -C packages/web typecheck`
Expected: PASS. Note the SCIP_LANGS default flip: `scip-python.test.ts` and `scip-multi` fixtures contain no `pom.xml`, so no java jobs appear in them; the e2e test repo likewise.

```bash
git add packages/server/src/graph/scip.ts packages/server/src/graph/provider.ts packages/server/src/db/schema.ts packages/server/src/repo/sessions.ts packages/server/src/types.ts packages/server/src/routes/sessions.ts packages/server/test/scip-java.test.ts packages/server/test/scip-cache.test.ts packages/server/test/schema.test.ts packages/server/test/routes.test.ts packages/web/src/api/client.ts packages/web/src/components/PlanView.tsx
git commit -m "feat: java degradation warnings — session index diagnostics (schema v5, API, banner)"
```

---

### Task 4: Dogfood checkpoint (controller-run, not a subagent task)

Run the aivo `introspector-obo` dogfood exactly as Phase 1 did (roadmap checkpoint):

1. Coursier must be durably available: `~/.local/bin/cs` (already installed during the Phase 3 spike session setup — verify with `cs version`; if missing, download the launcher gz from coursier releases into `~/.local/bin`).
2. Start the server against the aivo repo (`CRG_REPO_ROOT=/home/duuni/Projects/pareto/aivo` — or the introspector root as the session repo, matching how the Phase 1 dogfood ran), create a session for `introspector-obo` vs `main`.
3. **Expected:** the 19 changed Java files form flows (controller → service → introspector → policy/helper chains — the spike's preview found 20 controller→service/helper edges); Python MCP flows still present (Phase 1 regression check); cold-index wall-clock recorded; warm re-run served from cache.
4. Degradation check: restart the server with `PATH` stripped of `cs` (and no `SCIP_JAVA_CMD`) — session creation succeeds, Java files land residual-only, PlanView shows the amber warning banner with the install hint.
5. Screenshot the Java flow tracks + the warning banner; append checkpoint results to the roadmap doc (same style as the Phase 1 checkpoint note).

Playwright note: browsers only launch while Sami's X session is active — if `/remote-control` is active, notify and wait rather than hanging.

---

## Deferred / out of scope (recorded for later)

- Gradle-specific launch flags (scip-java auto-detects the build tool; only Maven is dogfooded here — Gradle rides on scip-java's own support untested).
- `settings.xml` in `~/.m2` (user-global Maven config) — only repo-level files can be fingerprinted; a user-global toolchain change over-invalidates nothing (accepted staleness risk of last resort, same class as a JDK upgrade).
- Bundling scip-java with the plugin (JVM tool, can't be bundled — the resolver + degradation IS the plugin story per the roadmap).
- Warning display beyond PlanView (e.g. in the walkthrough skill output) — the POST response now carries `indexWarnings`; consuming it in the skill is plugin-packaging scope.
