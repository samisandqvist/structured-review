# Polyglot Phase 2 — Per-Language Heuristics Implementation Plan

> Project, branch, and application identifiers in this historical note have been anonymized.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the TS-chauvinist assumptions left after Phase 1: per-language test-file detection (Java + Python), Python entry-point evidence (decorators + `__main__` guard), language-scoped index-cache fingerprints, and lock-in tests for the symbol-parsing paths the roadmap audit cleared.

**Architecture:** All changes live in `packages/server`. `isTestFile` gains per-language filename patterns. `entry-points.ts` gains a Python detector (`pythonEntryReasons`) that reads decorator lines and the `if __name__ == "__main__":` block; `entryEvidence` accepts detected reasons at a new 0.8 confidence tier; `scip.ts#getFlows` dispatches by file extension (`.py` → detector, else the existing `isExportedAt`). `subtreeFingerprint` accepts optional git pathspecs so each indexer job's cache key only moves on files its language cares about (source extensions + marker files) — the remedy for Phase 1's known limitation. Java annotation detectors are deferred to Phase 4 (no Java nodes exist in the graph until scip-java lands).

**Tech Stack:** TypeScript (Node ESM), vitest, git CLI via `execFileSync`. No new dependencies.

## Global Constraints

- Package manager: **pnpm** (never npm).
- All work in `packages/server`; run tests with `pnpm -C packages/server exec vitest run <file>` and the full suite with `pnpm -C packages/server test`.
- Typecheck with `pnpm -C packages/server typecheck` before each commit.
- Branch: `feat/polyglot-phase2` off `main`. Workflow is rebase + ff-only merge (no merge commits).
- TDD: write the failing test first in every task.
- The web UI renders `entryReasons` as opaque strings (`PlanView.tsx:193` joins them with `+`) — new reason values need **no** web changes.

---

### Task 1: Per-language `isTestFile`

**Files:**
- Modify: `packages/server/src/util.ts:5-6`
- Test: `packages/server/test/util.test.ts` (create)

**Interfaces:**
- Produces: `isTestFile(p: string): boolean` — same signature as today, now matching Python and Java test conventions in addition to TS/JS. Consumed unchanged by `graph/scip.ts`, `graph/crg.ts`, `residuals.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/util.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isTestFile } from "../src/util.js";

describe("isTestFile", () => {
  it("matches TS/JS test and spec files (existing behavior)", () => {
    expect(isTestFile("src/a.test.ts")).toBe(true);
    expect(isTestFile("src/a.spec.tsx")).toBe(true);
    expect(isTestFile("lib/b.test.mjs")).toBe(true);
    expect(isTestFile("src/__tests__/helpers.ts")).toBe(true);
    expect(isTestFile("src/app.ts")).toBe(false);
    expect(isTestFile("src/testing.ts")).toBe(false);
    expect(isTestFile("contest/x.ts")).toBe(false);
  });

  it("matches Python test conventions", () => {
    expect(isTestFile("mcp/svc/test_app.py")).toBe(true);
    expect(isTestFile("mcp/svc/app_test.py")).toBe(true);
    expect(isTestFile("mcp/svc/conftest.py")).toBe(true);
    expect(isTestFile("mcp/svc/tests/helpers.py")).toBe(true);
    expect(isTestFile("test_top.py")).toBe(true);
    expect(isTestFile("mcp/svc/app.py")).toBe(false);
    expect(isTestFile("mcp/svc/attest.py")).toBe(false);   // no "_test." boundary
    expect(isTestFile("mcp/svc/contest_x.py")).toBe(false); // "test_" not at segment start
  });

  it("matches Java test conventions", () => {
    expect(isTestFile("example-service/src/test/java/com/x/FooTest.java")).toBe(true);
    expect(isTestFile("src/test/java/Foo.java")).toBe(true);
    expect(isTestFile("src/main/java/com/x/FooTest.java")).toBe(true); // *Test.java anywhere
    expect(isTestFile("src/main/java/com/x/FooIT.java")).toBe(true);
    expect(isTestFile("src/main/java/com/x/Foo.java")).toBe(false);
    expect(isTestFile("src/main/java/com/x/Splitter.java")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/server exec vitest run test/util.test.ts`
Expected: FAIL — Python and Java cases fail (`test_app.py`, `FooTest.java` etc. return false).

- [ ] **Step 3: Implement per-language patterns**

Replace `isTestFile` in `packages/server/src/util.ts`:

```ts
/**
 * Per-language test-file detection (roadmap Phase 2), by filename shape:
 * TS/JS `*.test.ts` / `*.spec.tsx` …, Python `test_*.py` / `*_test.py` /
 * `conftest.py`, Java Maven `src/test/java/` trees plus surefire/failsafe
 * naming (`*Test.java`, `*IT.java`), and the shared test-directory rule.
 */
export const isTestFile = (p: string) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) ||
  /(^|\/)(test_[^/]*|[^/]+_test|conftest)\.py$/.test(p) ||
  /(^|\/)src\/test\/java\//.test(p) ||
  /(Test|IT)\.java$/.test(p) ||
  /(^|\/)(test|tests|__tests__)\//.test(p);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/server exec vitest run test/util.test.ts`
Expected: PASS (all three describe blocks).

- [ ] **Step 5: Full suite + typecheck, then commit**

Run: `pnpm -C packages/server test && pnpm -C packages/server typecheck`
Expected: all existing tests still pass (the TS patterns and directory rule are unchanged).

```bash
git add packages/server/src/util.ts packages/server/test/util.test.ts
git commit -m "feat(server): per-language isTestFile (python, java)"
```

---

### Task 2: Python entry-point evidence (decorators + `__main__` guard)

**Files:**
- Modify: `packages/server/src/graph/entry-points.ts`
- Modify: `packages/server/src/graph/scip.ts:201-213` (getFlows evidence dispatch)
- Test: `packages/server/test/entry-points.test.ts` (extend)
- Test: `packages/server/test/scip-python.test.ts` (extend fixture)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `type EntryReason = "graph-root" | "exported" | "configured" | "http-route" | "tool" | "cli"` (three new values).
  - `pythonEntryReasons(root: string, file: string, node: { label: string; startLine: number }, cache?: Map<string, string[]>): EntryReason[]` — detected reasons for a Python definition (empty array when none / file unreadable).
  - `entryEvidence(flags: { isRoot: boolean; isExported: boolean; isConfigured: boolean; detected?: EntryReason[] })` — new optional `detected` field; confidence tiers become configured 1.0 > detected 0.8 > root+exported 0.7 > bare root 0.4. Reason order: graph-root, exported, …detected, configured (existing tests stay green).

- [ ] **Step 1: Write the failing unit tests**

Append to `packages/server/test/entry-points.test.ts` (imports at top already include `mkdtempSync, writeFileSync, mkdirSync, tmpdir, join`; add `pythonEntryReasons` to the import from `../src/graph/entry-points.js`):

```ts
describe("pythonEntryReasons", () => {
  const write = (content: string) => {
    const dir = mkdtempSync(join(tmpdir(), "crw-pyentry-"));
    writeFileSync(join(dir, "app.py"), content);
    return dir;
  };

  it("detects http-route decorators above the definition", () => {
    const dir = write('@app.route("/hello")\ndef hello():\n    return "hi"\n');
    // enclosingRange may start at the def line…
    expect(pythonEntryReasons(dir, "app.py", { label: "hello", startLine: 2 })).toEqual(["http-route"]);
    // …or at the decorator line; both must detect.
    expect(pythonEntryReasons(dir, "app.py", { label: "hello", startLine: 1 })).toEqual(["http-route"]);
  });

  it("detects fastapi-style method decorators", () => {
    const dir = write('@router.get("/items")\ndef list_items():\n    return []\n');
    expect(pythonEntryReasons(dir, "app.py", { label: "list_items", startLine: 2 })).toEqual(["http-route"]);
  });

  it("detects mcp tool/resource/prompt decorators", () => {
    const dir = write('@mcp.tool()\ndef execute_sql(q: str):\n    return run(q)\n');
    expect(pythonEntryReasons(dir, "app.py", { label: "execute_sql", startLine: 2 })).toEqual(["tool"]);
  });

  it("detects click/typer command decorators", () => {
    const dir = write("@cli.command()\ndef sync():\n    pass\n");
    expect(pythonEntryReasons(dir, "app.py", { label: "sync", startLine: 2 })).toEqual(["cli"]);
  });

  it("detects a __main__ guard that calls the node", () => {
    const dir = write('def main():\n    pass\n\n\nif __name__ == "__main__":\n    main()\n');
    expect(pythonEntryReasons(dir, "app.py", { label: "main", startLine: 1 })).toEqual(["cli"]);
  });

  it("ignores unrelated decorators, other functions, and unreadable files", () => {
    const dir = write('@functools.lru_cache\ndef helper():\n    pass\n\n\nif __name__ == "__main__":\n    main()\n');
    expect(pythonEntryReasons(dir, "app.py", { label: "helper", startLine: 2 })).toEqual([]);
    expect(pythonEntryReasons("/nonexistent", "app.py", { label: "x", startLine: 1 })).toEqual([]);
  });

  it("collects stacked decorators and dedupes reasons", () => {
    const dir = write('@app.route("/a")\n@app.route("/b")\ndef multi():\n    pass\n');
    expect(pythonEntryReasons(dir, "app.py", { label: "multi", startLine: 3 })).toEqual(["http-route"]);
  });
});

describe("entryEvidence with detected reasons", () => {
  it("scores detected entries 0.8 and appends detected reasons before configured", () => {
    expect(entryEvidence({ isRoot: true, isExported: false, isConfigured: false, detected: ["tool"] }))
      .toEqual({ reasons: ["graph-root", "tool"], confidence: 0.8 });
  });
  it("configured still wins over detected", () => {
    expect(entryEvidence({ isRoot: true, isExported: false, isConfigured: true, detected: ["cli"] }))
      .toEqual({ reasons: ["graph-root", "cli", "configured"], confidence: 1.0 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C packages/server exec vitest run test/entry-points.test.ts`
Expected: FAIL — `pythonEntryReasons` is not exported; the `detected` cases fail.

- [ ] **Step 3: Implement detector + evidence extension**

In `packages/server/src/graph/entry-points.ts`, replace the `EntryReason` type and `entryEvidence`, and add `pythonEntryReasons`:

```ts
export type EntryReason = "graph-root" | "exported" | "configured" | "http-route" | "tool" | "cli";
```

```ts
// Single-line decorator shapes that mark real external entry points.
// Multi-line decorator calls (`@app.route(\n  "/x"\n)`) are not detected — v2
// heuristic, acceptable miss (falls back to graph-root 0.4).
const PY_DECORATOR_REASONS: [RegExp, EntryReason][] = [
  [/^@\w[\w.]*\.(?:route|get|post|put|delete|patch|head|options|websocket)\b/, "http-route"],
  [/^@\w[\w.]*\.(?:tool|resource|prompt)\b/, "tool"],
  [/^@\w[\w.]*\.(?:command|group)\b/, "cli"],
];

/**
 * Detected entry evidence for a Python definition: recognized decorators on
 * the def, or a module-level `if __name__ == "__main__":` block that calls it.
 * scip-python's enclosingRange may start at the def or at its first decorator,
 * so decorators are collected both at/below startLine and directly above it.
 */
export function pythonEntryReasons(
  root: string,
  file: string,
  node: { label: string; startLine: number },
  cache?: Map<string, string[]>
): EntryReason[] {
  let lines = cache?.get(file);
  if (!lines) {
    try {
      lines = readFileSync(join(root, file), "utf8").split("\n");
    } catch {
      return [];
    }
    cache?.set(file, lines);
  }
  const reasons = new Set<EntryReason>();

  const decoratorAt = (i: number): string | null => {
    const t = (lines![i] ?? "").trim();
    return t.startsWith("@") ? t : null;
  };
  const matchDecorator = (t: string) => {
    for (const [re, reason] of PY_DECORATOR_REASONS) if (re.test(t)) reasons.add(reason);
  };
  // At/below startLine: the span may open on decorator lines; stop at the def.
  for (let i = node.startLine - 1; i < lines.length; i++) {
    const t = decoratorAt(i);
    if (!t) break;
    matchDecorator(t);
  }
  // Directly above startLine: the span may open on the def line instead.
  for (let i = node.startLine - 2; i >= 0; i--) {
    const t = decoratorAt(i);
    if (!t) break;
    matchDecorator(t);
  }

  // `if __name__ == "__main__":` block calling this node -> cli entry.
  const guard = lines.findIndex((l) => /^if __name__ == ["']__main__["']\s*:/.test(l));
  if (guard !== -1) {
    const callRe = new RegExp(`\\b${node.label}\\s*\\(`);
    for (let i = guard + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() !== "" && !/^\s/.test(l)) break; // left the indented block
      if (callRe.test(l)) {
        reasons.add("cli");
        break;
      }
    }
  }
  return [...reasons];
}
```

```ts
/**
 * Deterministic confidence: explicit configuration is trusted outright;
 * detected framework evidence (route/tool/cli decorators, __main__ guard) is
 * stronger than an exported graph root; a bare graph root may just be a
 * utility the index sees no callers for.
 */
export function entryEvidence(flags: {
  isRoot: boolean;
  isExported: boolean;
  isConfigured: boolean;
  detected?: EntryReason[];
}): EntryEvidence {
  const detected = flags.detected ?? [];
  const reasons: EntryReason[] = [];
  if (flags.isRoot) reasons.push("graph-root");
  if (flags.isExported) reasons.push("exported");
  reasons.push(...detected);
  if (flags.isConfigured) reasons.push("configured");
  const confidence = flags.isConfigured
    ? 1.0
    : detected.length > 0
      ? 0.8
      : flags.isRoot && flags.isExported
        ? 0.7
        : 0.4;
  return { reasons, confidence };
}
```

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `pnpm -C packages/server exec vitest run test/entry-points.test.ts`
Expected: PASS, including all pre-existing entryEvidence tests (order and scores for the non-detected cases are unchanged).

- [ ] **Step 5: Dispatch by language in getFlows**

In `packages/server/src/graph/scip.ts`, import the detector (extend the existing import at line 14):

```ts
import { entryEvidence, isExportedAt, loadConfiguredEntries, pythonEntryReasons } from "./entry-points.js";
```

Replace the evidence computation inside `getFlows` (currently `scip.ts:204-208`):

```ts
        const isPy = n.file.endsWith(".py");
        const evidence = entryEvidence({
          isRoot: rootSyms.has(sym),
          // `export` keyword is a TS/JS concept; never probe it on Python files.
          isExported: isPy ? false : isExportedAt(this.repoRoot, n.file, n.startLine, fileCache),
          isConfigured: configuredSyms.has(sym),
          detected: isPy ? pythonEntryReasons(this.repoRoot, n.file, { label: n.label, startLine: n.startLine }, fileCache) : [],
        });
```

- [ ] **Step 6: Extend the scip-python integration test to prove the pipe-through**

In `packages/server/test/scip-python.test.ts`, replace the `app.py` fixture write (lines 23-26) with:

```ts
      writeFileSync(
        join(dir, "svc", "app.py"),
        'from helper import greet\n\n\ndef main() -> None:\n    print(greet("world"))\n\n\nif __name__ == "__main__":\n    main()\n'
      );
```

and extend the assertions after the existing `steps.map((s) => s.file)` check (line 35):

```ts
      expect(main!.entryReasons).toContain("cli");
      expect(main!.entryConfidence).toBe(0.8);
```

- [ ] **Step 7: Run the integration test**

Run: `pnpm -C packages/server exec vitest run test/scip-python.test.ts`
Expected: PASS (~10-30 s; real scip-python run). The `main` flow still has steps `["main", "greet"]` — the module-level guard call is not attributed to any function node, so `main` remains a graph root — and now carries `cli` evidence at 0.8.

- [ ] **Step 8: Full suite + typecheck, then commit**

Run: `pnpm -C packages/server test && pnpm -C packages/server typecheck`
Expected: PASS. (`e2e.test.ts` and `routes.test.ts` don't assert entryConfidence values for TS flows; TS behavior is unchanged anyway.)

```bash
git add packages/server/src/graph/entry-points.ts packages/server/src/graph/scip.ts packages/server/test/entry-points.test.ts packages/server/test/scip-python.test.ts
git commit -m "feat(server): python entry evidence — route/tool/cli decorators and __main__ guard"
```

---

### Task 3: Language-scoped subtree fingerprints

**Files:**
- Modify: `packages/server/src/diff.ts:112-147` (`subtreeFingerprint`)
- Modify: `packages/server/src/graph/roots.ts` (export pathspec helper)
- Modify: `packages/server/src/graph/scip.ts:262-265` (`jobStateKey`)
- Test: `packages/server/test/diff.test.ts` (extend)
- Test: `packages/server/test/roots.test.ts` (extend)

**Interfaces:**
- Consumes: `SOURCE_EXTS`, `MARKERS` (module-private consts in `roots.ts` — used in place, not exported).
- Produces:
  - `languagePathspecs(language: IndexerLanguage, root: string): string[]` in `roots.ts` — git pathspecs covering one language's index inputs under a root.
  - `subtreeFingerprint(subdir: string, root?: string, pathspecs?: string[]): string | null` — when `pathspecs` is given, the working-tree parts (diff + untracked) are scoped to them instead of the bare subdir pathspec. Omitting it preserves today's behavior exactly.

**Background (from the Phase 1 checkpoint note):** a language root at `""` (repo root) hashes `git diff HEAD -- .` — the whole repo — so editing a nested Python file re-indexes the repo-root TS job. Remedy: scope the diff and untracked listing to the language's source extensions plus its marker files (a `tsconfig.json`/`pyproject.toml` edit changes indexer behavior with no source edit, so markers must stay in the key). The HEAD-tree component stays subdir-scoped: commits still over-invalidate the repo-root job, but the edit loop — the case that bit — becomes language-scoped. Update the "Known limitation" doc comment on `subtreeFingerprint` accordingly.

- [ ] **Step 1: Write the failing pathspec-helper test**

Append to `packages/server/test/roots.test.ts` (add `languagePathspecs` to its import from `../src/graph/roots.js`):

```ts
describe("languagePathspecs", () => {
  it("covers source extensions and marker files under a nested root", () => {
    expect(languagePathspecs("py", "mcp/svc")).toEqual([
      ":(glob)mcp/svc/**/*.py",
      ":(glob)mcp/svc/**/pyproject.toml",
      ":(glob)mcp/svc/**/setup.py",
      ":(glob)mcp/svc/**/requirements.txt",
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
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/server exec vitest run test/roots.test.ts`
Expected: FAIL — `languagePathspecs` is not exported.

- [ ] **Step 3: Implement `languagePathspecs`**

Add to `packages/server/src/graph/roots.ts` (below `SOURCE_EXTS`):

```ts
/**
 * Git pathspecs covering one language's index inputs under a root: its source
 * files plus its marker files (a tsconfig/pyproject edit changes indexer
 * behavior even when no source file moved). Used to scope the index-cache
 * fingerprint so edits in one language don't invalidate another language's
 * job. In git glob magic a leading `**\/` also matches depth zero, so the
 * repo-root ("") specs cover top-level files.
 */
export function languagePathspecs(language: IndexerLanguage, root: string): string[] {
  const prefix = root ? `${root}/` : "";
  return [
    ...SOURCE_EXTS[language].map((ext) => `:(glob)${prefix}**/*${ext}`),
    ...MARKERS[language].map((m) => `:(glob)${prefix}**/${m}`),
  ];
}
```

Run: `pnpm -C packages/server exec vitest run test/roots.test.ts` — PASS.

- [ ] **Step 4: Write the failing fingerprint tests**

Append inside the existing `describe("subtreeFingerprint", …)` block in `packages/server/test/diff.test.ts` (it already has a git-fixture helper pattern nearby — follow the style of the tests at `diff.test.ts:344-395`; add `languagePathspecs` to the imports from `../src/graph/roots.js`):

```ts
  it("with pathspecs, only moves when files of that language (or its markers) change", () => {
    const dir = mkdtempSync(join(tmpdir(), "crw-fp-lang-"));
    try {
      const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
      g("init", "-b", "main");
      g("config", "user.email", "t@t");
      g("config", "user.name", "t");
      writeFileSync(join(dir, "package.json"), "{}");
      writeFileSync(join(dir, "a.ts"), "export const x = 1;\n");
      mkdirSync(join(dir, "mcp", "svc"), { recursive: true });
      writeFileSync(join(dir, "mcp", "svc", "pyproject.toml"), "[project]\n");
      writeFileSync(join(dir, "mcp", "svc", "b.py"), "x = 1\n");
      g("add", ".");
      g("commit", "-m", "init");

      const tsSpecs = languagePathspecs("ts", "");
      const pySpecs = languagePathspecs("py", "mcp/svc");
      const ts1 = subtreeFingerprint("", dir, tsSpecs);
      const py1 = subtreeFingerprint("mcp/svc", dir, pySpecs);

      // Editing a nested python file must NOT move the repo-root ts key.
      writeFileSync(join(dir, "mcp", "svc", "b.py"), "x = 2\n");
      expect(subtreeFingerprint("", dir, tsSpecs)).toBe(ts1);
      expect(subtreeFingerprint("mcp/svc", dir, pySpecs)).not.toBe(py1);

      // Editing a top-level ts file moves the ts key (zero-depth ** match), not py.
      const py2 = subtreeFingerprint("mcp/svc", dir, pySpecs);
      writeFileSync(join(dir, "a.ts"), "export const x = 2;\n");
      expect(subtreeFingerprint("", dir, tsSpecs)).not.toBe(ts1);
      expect(subtreeFingerprint("mcp/svc", dir, pySpecs)).toBe(py2);

      // Editing a ts marker file moves the ts key.
      const ts2 = subtreeFingerprint("", dir, tsSpecs);
      writeFileSync(join(dir, "package.json"), '{"name":"x"}');
      expect(subtreeFingerprint("", dir, tsSpecs)).not.toBe(ts2);

      // An untracked python file moves only the py key.
      const ts3 = subtreeFingerprint("", dir, tsSpecs);
      const py3 = subtreeFingerprint("mcp/svc", dir, pySpecs);
      writeFileSync(join(dir, "mcp", "svc", "c.py"), "y = 1\n");
      expect(subtreeFingerprint("", dir, tsSpecs)).toBe(ts3);
      expect(subtreeFingerprint("mcp/svc", dir, pySpecs)).not.toBe(py3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
```

(If `mkdirSync`/`rmSync` are not already imported in `diff.test.ts`, add them to its `node:fs` import.)

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm -C packages/server exec vitest run test/diff.test.ts`
Expected: FAIL — `subtreeFingerprint` takes 2 arguments; the third is ignored/type-errors, and the py-edit case moves the ts key.

- [ ] **Step 6: Implement the pathspec-scoped fingerprint**

In `packages/server/src/diff.ts`, change `subtreeFingerprint` (keep the tree-sha part exactly as is):

```ts
/**
 * Content-sensitive fingerprint of one subtree (a language root), or null
 * when git is unavailable. Keyed on the subtree's tree object sha at HEAD —
 * not HEAD itself — so commits that don't touch the subtree leave the key
 * unchanged; plus `git diff HEAD` (staged + unstaged) and each untracked
 * file's path and content, both scoped to `pathspecs` when given (the
 * caller's language-relevant files) and to the bare subdir otherwise.
 *
 * Known limitation: the HEAD component of the `""` (repo root) key is the
 * whole-repo tree sha, so any *commit* still moves a repo-root job's key
 * even when it touched nothing language-relevant. The working-tree parts —
 * the edit loop — are fully language-scoped via `pathspecs`.
 */
export function subtreeFingerprint(subdir: string, root: string = repoRoot(), pathspecs?: string[]): string | null {
  const specs = pathspecs ?? [subdir === "" ? "." : subdir];
  try {
    const h = createHash("sha256");
    try {
      const treeRef = subdir === "" ? "HEAD^{tree}" : `HEAD:${subdir}`;
      h.update(execFileSync("git", ["rev-parse", treeRef], { cwd: root, encoding: "utf8", ...QUIET }));
    } catch {
      // Subtree absent at HEAD (brand-new root): untracked contents below cover it.
      h.update("<no-tree>");
    }
    h.update(execFileSync("git", ["diff", "HEAD", "--", ...specs], { cwd: root, maxBuffer: 256 * 1024 * 1024, ...QUIET }));
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", ...specs], { cwd: root, encoding: "utf8", ...QUIET })
      .split("\n").filter(Boolean);
    for (const f of untracked) {
      h.update(f);
      try { h.update(readFileSync(join(root, f))); } catch { h.update("<unreadable>"); }
    }
    return h.digest("hex");
  } catch {
    return null;
  }
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm -C packages/server exec vitest run test/diff.test.ts`
Expected: PASS, including the three pre-existing `subtreeFingerprint` tests (no-pathspec behavior unchanged).

- [ ] **Step 8: Wire the provider's job key**

In `packages/server/src/graph/scip.ts`, extend the roots import (line 11) with `languagePathspecs`:

```ts
import { discoverLanguageRoots, languagePathspecs, rootHasSources, type IndexerJob } from "./roots.js";
```

and change `jobStateKey`:

```ts
  /** Language-scoped subtree cache key; any git failure yields a unique key (cache miss, never stale). */
  protected jobStateKey(job: IndexerJob): string {
    return subtreeFingerprint(job.root, this.repoRoot, languagePathspecs(job.language, job.root)) ?? `no-git:${Math.random()}`;
  }
```

- [ ] **Step 9: Full suite + typecheck, then commit**

Run: `pnpm -C packages/server test && pnpm -C packages/server typecheck`
Expected: PASS — `scip-cache.test.ts` overrides `jobStateKey`/`repoStateKey` in its fakes, so cache semantics tests are unaffected.

```bash
git add packages/server/src/diff.ts packages/server/src/graph/roots.ts packages/server/src/graph/scip.ts packages/server/test/diff.test.ts packages/server/test/roots.test.ts
git commit -m "feat(server): language-scoped subtree fingerprints for the index cache"
```

---

### Task 4: Lock-in tests for audited symbol parsing (labelOf, `#`-method kind)

The roadmap audit cleared `labelOf` and the `#`-method heuristic for Python symbol shapes by probe; this task pins that behavior with tests so a future symbol-format change fails loudly. **Tests only — expect zero production changes.** If a test in this task fails, STOP and report: that is an audit finding, not something to patch ad hoc.

**Files:**
- Test: `packages/server/test/scip-multi.test.ts` (extend)
- Test: `packages/server/test/routes.test.ts` (extend)

**Interfaces:**
- Consumes: `buildGraphFromIndex` (from Task-independent existing code), `createApp`, `StubGraphProvider` patterns from `routes.test.ts`.
- Produces: nothing new — regression coverage only.

- [ ] **Step 1: Add python symbol-shape tests to scip-multi.test.ts**

Append to `packages/server/test/scip-multi.test.ts`:

```ts
describe("python symbol shapes (audit lock-in)", () => {
  // Real scip-python shapes: backticked dotted module descriptor, `#` for
  // methods, `().` suffix for callables.
  const PY_FN = "scip-python python svc 0.0.1 `app.web`/handler().";
  const PY_METHOD = "scip-python python svc 0.0.1 `app.client`/Client#send().";

  it("labels backticked-module functions and #-methods by their trailing identifier", () => {
    const documents: ScipDocument[] = [
      {
        relativePath: "app/web.py",
        occurrences: [
          { symbol: PY_FN, symbolRoles: 1, range: [0, 4, 11], enclosingRange: [0, 0, 2, 0] },
          { symbol: PY_METHOD, symbolRoles: 0, range: [1, 4, 10] }, // handler calls Client.send
        ],
      },
      {
        relativePath: "app/client.py",
        occurrences: [{ symbol: PY_METHOD, symbolRoles: 1, range: [1, 8, 12], enclosingRange: [1, 4, 3, 0] }],
      },
    ];
    const g = buildGraphFromIndex({ documents }, "/repo");
    expect(g.nodes.get(PY_FN)?.label).toBe("handler");
    expect(g.nodes.get(PY_METHOD)?.label).toBe("send");
    expect(g.callAdj.get(PY_FN)).toEqual([PY_METHOD]);
  });
});
```

Run: `pnpm -C packages/server exec vitest run test/scip-multi.test.ts`
Expected: PASS immediately (behavior already correct — this is a lock-in). If it FAILS, stop and report the discrepancy.

- [ ] **Step 2: Add a changes-route kind test for python stableIds**

Append to `packages/server/test/routes.test.ts`, inside the `describe("GET /api/sessions/:id/changes", …)` block (add `GraphProvider` to the existing type import from `../src/graph/provider.js`):

```ts
  it("classifies python #-method stableIds as methods and plain callables as functions", async () => {
    const pyProvider: GraphProvider = {
      async getChangeSubgraph(): Promise<ChangeSubgraph> {
        return {
          nodes: [
            { stableId: "scip-python python svc 0.0.1 `app`/main().", label: "main", file: "app.py", startLine: 1, endLine: 3, isEntryPoint: true, changeStatus: "changed", isTest: false },
            { stableId: "scip-python python svc 0.0.1 `app`/Client#send().", label: "send", file: "app.py", startLine: 5, endLine: 8, isEntryPoint: false, changeStatus: "changed", isTest: false },
          ],
          edges: [],
        };
      },
      async getFlows() { return []; },
      async getNeighbors() { return { callers: [], callees: [] }; },
    };
    const pyApp = createApp({ db, graphProvider: pyProvider, repoRoot: fixtureRoot });
    const cr = await pyApp.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const res = await pyApp.request(`/api/sessions/${session.id}/changes`);
    const { changes } = await res.json();
    const byLabel = Object.fromEntries(changes.map((c: any) => [c.label, c.kind]));
    expect(byLabel).toEqual({ main: "function", send: "method" });
  });
```

Run: `pnpm -C packages/server exec vitest run test/routes.test.ts`
Expected: PASS immediately. If it FAILS, stop and report.

- [ ] **Step 3: Full suite + typecheck, then commit**

Run: `pnpm -C packages/server test && pnpm -C packages/server typecheck`
Expected: PASS.

```bash
git add packages/server/test/scip-multi.test.ts packages/server/test/routes.test.ts
git commit -m "test(server): lock in python symbol labeling and #-method kind heuristic"
```

---

## Deferred / out of scope (recorded for later phases)

- **Java entry-evidence detectors** (`@RestController`, `@Scheduled`, `@KafkaListener` → http-route/job/event): deferred to Phase 4 — no Java nodes exist in the graph until scip-java lands, so the detector would be dead code. The `EntryReason` union and `detected` plumbing added here are the extension point.
- **Multi-line Python decorators** (`@app.route(\n  "/x"\n)`): not detected; falls back to graph-root 0.4. Revisit only if it misses real entries in dogfooding.
- **HEAD-tree component of the repo-root fingerprint**: still whole-repo — commits over-invalidate the repo-root job. The working-tree edit loop (the observed pain) is fixed; a filtered `git ls-tree -r HEAD` hash is the follow-up if commit-loop invalidation ever bites.
- **Rust heuristics** (`*_test.rs`, `tests/`, `target/`): Phase 5.
