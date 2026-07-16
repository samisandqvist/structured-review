# Phase 1: Multi-Index Orchestration + scip-python — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The SCIP graph provider discovers one language root per TS/Python project in the repo, runs the matching SCIP indexer per root, merges the decoded indexes into the single call graph the rest of the product already consumes, caches per (indexer, root, subtree-fingerprint), and fails loudly when an indexer breaks.

**Architecture:** `ScipGraphProvider.indexAndBuild()` stops being "run scip-typescript once at repo root" and becomes "discover jobs → per-job cached documents → concatenate → `buildGraphFromIndex`". Document paths from each indexer are re-rooted to repo-relative before merging (the one known sharp edge). SCIP symbols are namespaced by scheme+package, so merged documents cannot collide. A new `IndexError` (phase `"index"`) extends the GitError-style fail-loudly contract into session creation.

**Tech Stack:** TypeScript (strict, ESM with `.js` import suffixes), Hono, vitest, protobufjs, `@sourcegraph/scip-typescript` (existing dep), `@sourcegraph/scip-python` (new dep, same npm acquisition path).

**Source spec:** `docs/superpowers/plans/2026-07-15-polyglot-provider-roadmap.md`, section "Phase 1".

## Global Constraints

- pnpm, never npm. Run tests from repo root: `pnpm vitest run packages/server/test/<file>.ts`. Typecheck: `pnpm -r typecheck`.
- ESM everywhere: relative imports carry the `.js` suffix even in `.ts` files.
- Only one new runtime dependency: `@sourcegraph/scip-python` in `packages/server`.
- Env-var config style follows existing precedent (`SCIP_NO_CACHE`, `SCIP_REPO_ROOT`): the new filter is `SCIP_LANGS` (comma list, default `ts,py`).
- Java roots (`pom.xml`/`build.gradle`/`build.gradle.kts`) are *detected* by discovery but NOT enabled by default — Phase 4 turns them on.
- Fail loudly: indexer exit ≠ 0 or an empty index for a root that plainly has sources must surface at session creation as a 400 with `phase: "index"` — never a silently orphan-only plan.
- Commit after every task. Commit messages end with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` (plus the Claude-Session line git instructions require).
- Existing behavior to preserve: a repo with no marker files anywhere still gets the old treatment (scip-typescript `--infer-tsconfig` at repo root).

---

### Task 1: `subtreeFingerprint` in diff.ts

Cache key scoped to one language root: a Python edit must not move the TS key. Uses the subtree's **tree object sha at HEAD** (`git rev-parse HEAD:<subdir>`) rather than HEAD itself, so a commit that only touches a sibling leaves the key unchanged. Working-tree changes come from `git diff HEAD -- <subdir>`; untracked files under the subtree are hashed by path+content (same recipe as `repoFingerprint`). This resolves roadmap open question 1.

**Files:**
- Modify: `packages/server/src/diff.ts` (add function after `repoFingerprint`, ~line 110)
- Test: `packages/server/test/diff.test.ts` (append a describe block)

**Interfaces:**
- Produces: `subtreeFingerprint(subdir: string, root?: string): string | null` — `subdir` is repo-relative (`""` = whole repo); `null` when git is unavailable. Task 4 consumes it.

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/test/diff.test.ts` (it already imports `execFileSync`, `mkdtempSync`, `writeFileSync`, `rmSync`, `tmpdir`, `join` — add any that are missing, and import `subtreeFingerprint` from `../src/diff.js`):

```ts
describe("subtreeFingerprint", () => {
  function makeRepo(): { dir: string; git: (...a: string[]) => string } {
    const dir = mkdtempSync(join(tmpdir(), "crw-subtree-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
    git("init", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    mkdirSync(join(dir, "a"));
    mkdirSync(join(dir, "b"));
    writeFileSync(join(dir, "a", "f.txt"), "a1\n");
    writeFileSync(join(dir, "b", "f.txt"), "b1\n");
    git("add", ".");
    git("commit", "-m", "init");
    return { dir, git };
  }

  it("moves when the subtree changes and stays put when a sibling changes", () => {
    const { dir } = makeRepo();
    try {
      const a1 = subtreeFingerprint("a", dir);
      const b1 = subtreeFingerprint("b", dir);
      writeFileSync(join(dir, "b", "f.txt"), "b2\n");
      expect(subtreeFingerprint("a", dir)).toBe(a1);
      expect(subtreeFingerprint("b", dir)).not.toBe(b1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a commit touching only a sibling leaves the key unchanged (tree sha, not HEAD)", () => {
    const { dir, git } = makeRepo();
    try {
      const a1 = subtreeFingerprint("a", dir);
      writeFileSync(join(dir, "b", "f.txt"), "b2\n");
      git("add", ".");
      git("commit", "-m", "touch b only");
      expect(subtreeFingerprint("a", dir)).toBe(a1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sees untracked files under the subtree, including in a root absent at HEAD", () => {
    const { dir } = makeRepo();
    try {
      mkdirSync(join(dir, "newroot"));
      writeFileSync(join(dir, "newroot", "x.py"), "one\n");
      const k1 = subtreeFingerprint("newroot", dir);
      expect(k1).not.toBeNull();
      writeFileSync(join(dir, "newroot", "x.py"), "two\n");
      expect(subtreeFingerprint("newroot", dir)).not.toBe(k1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("subdir '' fingerprints the whole repo", () => {
    const { dir } = makeRepo();
    try {
      const k1 = subtreeFingerprint("", dir);
      writeFileSync(join(dir, "a", "f.txt"), "a2\n");
      expect(subtreeFingerprint("", dir)).not.toBe(k1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when git is unavailable", () => {
    const dir = mkdtempSync(join(tmpdir(), "crw-subtree-nogit-"));
    try {
      expect(subtreeFingerprint("a", dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

Note: `mkdirSync` must be in the `node:fs` import list of the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/server/test/diff.test.ts`
Expected: FAIL — `subtreeFingerprint` is not exported.

- [ ] **Step 3: Implement**

In `packages/server/src/diff.ts`, directly after `repoFingerprint` (ends ~line 110):

```ts
/**
 * Content-sensitive fingerprint of one subtree (a language root), or null
 * when git is unavailable. Keyed on the subtree's tree object sha at HEAD —
 * not HEAD itself — so commits that don't touch the subtree leave the key
 * unchanged; plus `git diff HEAD -- <subdir>` (staged + unstaged) and each
 * untracked file's path and content under the subtree.
 */
export function subtreeFingerprint(subdir: string, root: string = repoRoot()): string | null {
  const pathspec = subdir === "" ? "." : subdir;
  try {
    const h = createHash("sha256");
    try {
      const treeRef = subdir === "" ? "HEAD^{tree}" : `HEAD:${subdir}`;
      h.update(execFileSync("git", ["rev-parse", treeRef], { cwd: root, encoding: "utf8", ...QUIET }));
    } catch {
      // Subtree absent at HEAD (brand-new root): untracked contents below cover it.
      h.update("<no-tree>");
    }
    h.update(execFileSync("git", ["diff", "HEAD", "--", pathspec], { cwd: root, maxBuffer: 256 * 1024 * 1024, ...QUIET }));
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", pathspec], { cwd: root, encoding: "utf8", ...QUIET })
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/server/test/diff.test.ts`
Expected: PASS (all pre-existing diff tests too).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/diff.ts packages/server/test/diff.test.ts
git commit -m "feat(server): subtree-scoped content fingerprint for per-root index caching"
```

---

### Task 2: Language-root discovery (`graph/roots.ts`)

Walk the repo for marker files; one indexer job per root; drop roots nested inside another root of the *same* language (a different-language root nested inside survives — that's the whole point). Java is detected but callers filter it out until Phase 4.

**Files:**
- Create: `packages/server/src/graph/roots.ts`
- Test: `packages/server/test/roots.test.ts`

**Interfaces:**
- Produces:
  - `type IndexerLanguage = "ts" | "py" | "java"`
  - `interface IndexerJob { language: IndexerLanguage; root: string; hasSources: boolean }` — `root` repo-relative, `""` = repo root
  - `discoverLanguageRoots(repoRoot: string): IndexerJob[]` — deterministic order (sorted by root, then language)
  - `rootHasSources(absRoot: string, language: IndexerLanguage): boolean` — exported for the Task 4 fallback

- [ ] **Step 1: Write the failing tests**

Create `packages/server/test/roots.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverLanguageRoots, rootHasSources } from "../src/graph/roots.js";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/server/test/roots.test.ts`
Expected: FAIL — module `../src/graph/roots.js` not found.

- [ ] **Step 3: Implement**

Create `packages/server/src/graph/roots.ts`:

```ts
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Language-root discovery for the multi-index SCIP provider: one indexer job
 * per project root, detected by marker files. A root nested inside another
 * root of the SAME language is dropped (the outer indexer covers it — e.g.
 * workspace packages under a monorepo root); a different-language root nested
 * inside survives (a Python service inside a TS monorepo).
 *
 * Java is detected here but only enabled in Phase 4 — callers filter by
 * enabled language (see SCIP_LANGS in scip.ts).
 */
export type IndexerLanguage = "ts" | "py" | "java";

export interface IndexerJob {
  language: IndexerLanguage;
  /** Repo-relative root directory; "" = repo root. */
  root: string;
  /** The root contains at least one source file of its language. */
  hasSources: boolean;
}

const MARKERS: Record<IndexerLanguage, string[]> = {
  ts: ["tsconfig.json", "package.json"],
  py: ["pyproject.toml", "setup.py", "requirements.txt"],
  java: ["pom.xml", "build.gradle", "build.gradle.kts"],
};

const SOURCE_EXTS: Record<IndexerLanguage, string[]> = {
  ts: [".ts", ".tsx", ".mts", ".cts"],
  py: [".py"],
  java: [".java"],
};

// Never descend into dependency trees, build output, or venvs; hidden dirs
// (".git", ".venv", ".hidden") are skipped by the dot rule.
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "coverage", "venv", "__pycache__"]);

export function discoverLanguageRoots(repoRoot: string): IndexerJob[] {
  const candidates: { language: IndexerLanguage; root: string }[] = [];
  walk(repoRoot, "", candidates);
  const kept = candidates.filter(
    (c) => !candidates.some((o) => o.language === c.language && o.root !== c.root && isInside(c.root, o.root))
  );
  return kept
    .map((c) => ({ ...c, hasSources: rootHasSources(c.root ? join(repoRoot, c.root) : repoRoot, c.language) }))
    .sort((a, b) => a.root.localeCompare(b.root) || a.language.localeCompare(b.language));
}

/** True when `child` is strictly inside `parent` ("" = repo root contains everything else). */
function isInside(child: string, parent: string): boolean {
  return parent === "" ? child !== "" : child.startsWith(parent + "/");
}

function walk(abs: string, rel: string, out: { language: IndexerLanguage; root: string }[]): void {
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  const fileNames = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
  for (const language of Object.keys(MARKERS) as IndexerLanguage[]) {
    if (MARKERS[language].some((m) => fileNames.has(m))) out.push({ language, root: rel });
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    walk(join(abs, e.name), rel ? `${rel}/${e.name}` : e.name, out);
  }
}

/** Does `absRoot` contain any source file of `language`? (Same skip rules as the walk.) */
export function rootHasSources(absRoot: string, language: IndexerLanguage): boolean {
  const exts = SOURCE_EXTS[language];
  const stack = [absRoot];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && exts.some((x) => e.name.endsWith(x))) return true;
      if (e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) stack.push(join(dir, e.name));
    }
  }
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/server/test/roots.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/graph/roots.ts packages/server/test/roots.test.ts
git commit -m "feat(server): language-root discovery for multi-index orchestration"
```

---

### Task 3: `IndexError` + document re-rooting (pure pieces of the merge)

The merge's one sharp edge: each indexer emits document paths relative to *its own* root; they must become repo-relative before `buildGraphFromIndex`. Also introduce the `IndexError` phase error (GitError-style) that Tasks 4–6 throw and catch.

**Files:**
- Modify: `packages/server/src/graph/scip.ts` — export `ScipDocument`, add `IndexError` and `rerootDocuments` (near the "SCIP decoding" section, ~line 270)
- Test: `packages/server/test/scip-multi.test.ts` (new)

**Interfaces:**
- Produces:
  - `class IndexError extends Error { readonly phase: "index" }`
  - `rerootDocuments(docs: ScipDocument[], jobRoot: string, absRoot: string): ScipDocument[]` — strips an absolute `absRoot` prefix if the indexer emitted one, then prefixes `jobRoot`
  - `ScipDocument` and `ScipIndex` become exported interfaces (they exist today as private interfaces at `scip.ts:278-284`)

- [ ] **Step 1: Write the failing tests**

Create `packages/server/test/scip-multi.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildGraphFromIndex, rerootDocuments, IndexError, type ScipDocument } from "../src/graph/scip.js";

const TS_MAIN = "scip-typescript npm pkg 1.0 src/`a.ts`/f().";
const TS_UTIL = "scip-typescript npm pkg 1.0 src/`a.ts`/g().";
const PY_MAIN = "scip-python python svc 0.0.1 app/main().";
const PY_GREET = "scip-python python svc 0.0.1 helper/greet().";

const tsDocs: ScipDocument[] = [
  {
    relativePath: "src/a.ts",
    occurrences: [
      { symbol: TS_MAIN, symbolRoles: 1, range: [0, 9, 10], enclosingRange: [0, 0, 4, 1] },
      { symbol: TS_UTIL, symbolRoles: 1, range: [6, 9, 10], enclosingRange: [6, 0, 8, 1] },
      { symbol: TS_UTIL, symbolRoles: 0, range: [2, 2, 3] }, // f calls g
    ],
  },
];
const pyDocs: ScipDocument[] = [
  {
    relativePath: "app.py",
    occurrences: [
      { symbol: PY_MAIN, symbolRoles: 1, range: [2, 4, 8], enclosingRange: [2, 0, 4, 0] },
      { symbol: PY_GREET, symbolRoles: 0, range: [3, 10, 15] }, // main calls greet
    ],
  },
  {
    relativePath: "helper.py",
    occurrences: [{ symbol: PY_GREET, symbolRoles: 1, range: [0, 4, 9], enclosingRange: [0, 0, 1, 0] }],
  },
];

describe("rerootDocuments", () => {
  it("prefixes the job root onto each document path", () => {
    const out = rerootDocuments(pyDocs, "mcp/svc", "/repo/mcp/svc");
    expect(out.map((d) => d.relativePath)).toEqual(["mcp/svc/app.py", "mcp/svc/helper.py"]);
  });

  it("strips an absolute indexer-root prefix before prefixing", () => {
    const abs: ScipDocument[] = [{ relativePath: "/repo/mcp/svc/app.py", occurrences: [] }];
    expect(rerootDocuments(abs, "mcp/svc", "/repo/mcp/svc")[0].relativePath).toBe("mcp/svc/app.py");
  });

  it("is the identity for a repo-root job", () => {
    expect(rerootDocuments(tsDocs, "", "/repo").map((d) => d.relativePath)).toEqual(["src/a.ts"]);
  });

  it("does not mutate its input", () => {
    rerootDocuments(pyDocs, "mcp/svc", "/repo/mcp/svc");
    expect(pyDocs[0].relativePath).toBe("app.py");
  });
});

describe("merged multi-root graph", () => {
  it("builds one graph with repo-relative paths and per-root call edges", () => {
    const documents = [
      ...rerootDocuments(tsDocs, "", "/repo"),
      ...rerootDocuments(pyDocs, "mcp/svc", "/repo/mcp/svc"),
    ];
    const g = buildGraphFromIndex({ documents }, "/repo");
    expect(g.nodes.get(TS_MAIN)?.file).toBe("src/a.ts");
    expect(g.nodes.get(PY_MAIN)?.file).toBe("mcp/svc/app.py");
    expect(g.nodes.get(PY_GREET)?.file).toBe("mcp/svc/helper.py");
    expect(g.callAdj.get(TS_MAIN)).toEqual([TS_UTIL]);
    expect(g.callAdj.get(PY_MAIN)).toEqual([PY_GREET]);
  });
});

describe("IndexError", () => {
  it("carries the index phase", () => {
    const e = new IndexError("scip-python failed");
    expect(e.phase).toBe("index");
    expect(e.name).toBe("IndexError");
    expect(e).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/server/test/scip-multi.test.ts`
Expected: FAIL — `rerootDocuments`/`IndexError`/`ScipDocument` not exported.

- [ ] **Step 3: Implement**

In `packages/server/src/graph/scip.ts`:

3a. Export the decoding interfaces (currently private, ~line 272-284) — change `interface ScipOccurrence`, `interface ScipDocument`, `interface ScipIndex` to `export interface ...`.

3b. Add after the `ScipIndex` interface:

```ts
/**
 * Indexer failure surfaced to session creation as a phase error, mirroring
 * GitError: an indexer that exits non-zero or produces an empty index for a
 * root that plainly has sources must not silently yield an orphan-only plan.
 */
export class IndexError extends Error {
  readonly phase = "index" as const;
  constructor(message: string) {
    super(message);
    this.name = "IndexError";
  }
}

/**
 * Re-root one indexer job's documents to repo-relative paths. Each indexer
 * runs with cwd = its own root and emits paths relative to it (occasionally
 * absolute); the merged graph needs repo-relative paths for git diffs.
 */
export function rerootDocuments(docs: ScipDocument[], jobRoot: string, absRoot: string): ScipDocument[] {
  const absSlash = absRoot.endsWith("/") ? absRoot : `${absRoot}/`;
  const prefix = jobRoot ? `${jobRoot}/` : "";
  return docs.map((d) => {
    let p = d.relativePath ?? "";
    if (p.startsWith(absSlash)) p = p.slice(absSlash.length);
    return { ...d, relativePath: `${prefix}${p}` };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/server/test/scip-multi.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm -r typecheck` — expected clean.

```bash
git add packages/server/src/graph/scip.ts packages/server/test/scip-multi.test.ts
git commit -m "feat(server): IndexError phase error + document re-rooting for index merge"
```

---

### Task 4: Multi-job orchestration + per-job cache in `ScipGraphProvider`

Rewire `indexAndBuild()` from "one scip-typescript run at repo root" to "discover jobs → per-job cached document sets → concatenate → build". Two cache layers: the existing whole-repo promise cache (`buildGraph`, unchanged) makes the no-change path free; a new per-job cache keyed on `subtreeFingerprint` makes a Python edit skip the TS re-index. TS-only repos behave exactly as today (single job at the discovered TS root).

**Files:**
- Modify: `packages/server/src/graph/scip.ts` — replace `indexAndBuild` (~lines 237-260) and `resolveScipTypescriptBin` (~lines 263-268); add `discoverJobs`, `jobStateKey`, `jobDocuments`, `runIndexer`; extend imports
- Test: `packages/server/test/scip-cache.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `discoverLanguageRoots`, `rootHasSources`, `IndexerJob` (Task 2); `subtreeFingerprint` (Task 1); `IndexError`, `rerootDocuments`, `ScipDocument`, `ScipIndex` (Task 3).
- Produces (all `protected`, for tests and Task 5):
  - `discoverJobs(): IndexerJob[]` — applies the `SCIP_LANGS` filter (default `"ts,py"`) and the no-markers fallback
  - `jobStateKey(job: IndexerJob): string`
  - `runIndexer(job: IndexerJob): Promise<ScipDocument[]>` — runs the language's indexer, decodes, re-roots, empty-index check; Task 5 adds the `py` branch
- Env: `SCIP_LANGS` (comma list) filters enabled languages; `SCIP_NO_CACHE=1` now bypasses both cache layers.

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/test/scip-cache.test.ts` (add imports: `type IndexerJob` from `../src/graph/roots.js`, `type ScipDocument` from `../src/graph/scip.js`):

```ts
describe("per-job cache", () => {
  class MultiFake extends ScipGraphProvider {
    ran: string[] = [];
    state: Record<string, string> = { ts: "a", py: "a" };
    failPy = false;
    protected override discoverJobs(): IndexerJob[] {
      return [
        { language: "ts", root: "", hasSources: true },
        { language: "py", root: "svc", hasSources: true },
      ];
    }
    // Whole-repo key = both subtree keys, so any edit invalidates the outer
    // cache (like the real repoFingerprint) while job caches stay per-root.
    protected override repoStateKey(): string { return JSON.stringify(this.state); }
    protected override jobStateKey(job: IndexerJob): string { return this.state[job.language]; }
    protected override runIndexer(job: IndexerJob): Promise<ScipDocument[]> {
      this.ran.push(`${job.language}:${job.root}`);
      if (this.failPy && job.language === "py") return Promise.reject(new Error("py indexer died"));
      return Promise.resolve([]);
    }
  }

  it("first build runs every job", async () => {
    const p = new MultiFake({ repoRoot: "/tmp" });
    await p.getNeighbors("x");
    expect(p.ran).toEqual(["ts:", "py:svc"]);
  });

  it("editing one language's subtree re-runs only that job", async () => {
    const p = new MultiFake({ repoRoot: "/tmp" });
    await p.getNeighbors("x");
    p.state = { ...p.state, py: "b" };
    await p.getNeighbors("x");
    expect(p.ran).toEqual(["ts:", "py:svc", "py:svc"]);
  });

  it("a failed job is dropped from the job cache so the next build retries it", async () => {
    const p = new MultiFake({ repoRoot: "/tmp" });
    p.failPy = true;
    await expect(p.getNeighbors("x")).rejects.toThrow("py indexer died");
    p.failPy = false;
    p.state = { ...p.state }; // same keys: ts job cache must survive the failure
    await p.getNeighbors("x");
    expect(p.ran).toEqual(["ts:", "py:svc", "py:svc"]);
  });

  it("SCIP_NO_CACHE=1 bypasses the job cache too", async () => {
    process.env.SCIP_NO_CACHE = "1";
    const p = new MultiFake({ repoRoot: "/tmp" });
    await p.getNeighbors("x");
    await p.getNeighbors("x");
    expect(p.ran).toEqual(["ts:", "py:svc", "ts:", "py:svc"]);
  });
});

describe("discoverJobs filtering", () => {
  class JobsProbe extends ScipGraphProvider {
    jobs: IndexerJob[] = [];
    publicJobs(): IndexerJob[] { return this.discoverJobs(); }
  }
  afterEach(() => { delete process.env.SCIP_LANGS; });

  it("SCIP_LANGS filters enabled languages", () => {
    process.env.SCIP_LANGS = "py";
    // this repo has a ts root and no py root -> filtered to nothing -> but the
    // fallback only fires when discovery found NO jobs at all, not when the
    // filter removed them.
    const p = new JobsProbe();
    expect(p.publicJobs()).toEqual([]);
  });

  it("defaults to ts,py — java roots are excluded until Phase 4", () => {
    const p = new JobsProbe();
    expect(p.publicJobs().every((j) => j.language === "ts" || j.language === "py")).toBe(true);
    expect(p.publicJobs().length).toBeGreaterThan(0); // this repo's own ts root
  });
});
```

Note: the existing `FakeProvider`/`GraphStub` tests override `indexAndBuild` directly and must keep passing unchanged — `indexAndBuild` stays the orchestration entry point.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/server/test/scip-cache.test.ts`
Expected: FAIL — `discoverJobs`/`jobStateKey`/`runIndexer` do not exist (TS compile errors on the overrides).

- [ ] **Step 3: Implement**

In `packages/server/src/graph/scip.ts`:

3a. Extend imports:

```ts
import { fileChangedRanges, rangesOverlap, repoFingerprint, repoRoot, subtreeFingerprint, type LineRange } from "../diff.js";
import { discoverLanguageRoots, rootHasSources, type IndexerJob } from "./roots.js";
```

3b. Add a field next to the existing `cache` field (~line 58):

```ts
private jobCache = new Map<string, { key: string; docs: Promise<ScipDocument[]> }>();
```

3c. Replace `indexAndBuild` (~lines 237-260) and `resolveScipTypescriptBin` (~lines 263-268) with:

```ts
  /** Enabled indexer jobs: discovered roots filtered by SCIP_LANGS (default ts,py). */
  protected discoverJobs(): IndexerJob[] {
    const enabled = new Set(
      (process.env.SCIP_LANGS ?? "ts,py").split(",").map((s) => s.trim()).filter(Boolean)
    );
    const discovered = discoverLanguageRoots(this.repoRoot);
    const jobs = discovered.filter((j) => enabled.has(j.language));
    // No marker files anywhere in the repo: preserve the old single-indexer
    // behavior (scip-typescript --infer-tsconfig at repo root).
    if (discovered.length === 0 && enabled.has("ts")) {
      return [{ language: "ts", root: "", hasSources: rootHasSources(this.repoRoot, "ts") }];
    }
    return jobs;
  }

  /** Run every enabled indexer job (each cached per subtree) and merge the documents. */
  protected async indexAndBuild(): Promise<BuiltGraph> {
    this.proto ??= await protobuf.load(SCIP_PROTO);
    const jobs = this.discoverJobs();
    const perJob = await Promise.all(jobs.map((j) => this.jobDocuments(j)));
    return buildGraphFromIndex({ documents: perJob.flat() }, this.repoRoot);
  }

  /** Subtree-scoped cache key; any git failure yields a unique key (cache miss, never stale). */
  protected jobStateKey(job: IndexerJob): string {
    return subtreeFingerprint(job.root, this.repoRoot) ?? `no-git:${Math.random()}`;
  }

  /** Index a root at most once per subtree state; concurrent callers share the run. */
  private jobDocuments(job: IndexerJob): Promise<ScipDocument[]> {
    if (process.env.SCIP_NO_CACHE === "1") return this.runIndexer(job);
    const id = `${job.language} ${job.root}`;
    const key = this.jobStateKey(job);
    const hit = this.jobCache.get(id);
    if (hit?.key === key) return hit.docs;
    const entry = { key, docs: this.runIndexer(job) };
    this.jobCache.set(id, entry);
    entry.docs.catch(() => {
      if (this.jobCache.get(id) === entry) this.jobCache.delete(id);
    });
    return entry.docs;
  }

  /** Run one job's SCIP indexer, decode its index, and re-root the documents. */
  protected async runIndexer(job: IndexerJob): Promise<ScipDocument[]> {
    const absRoot = job.root ? join(this.repoRoot, job.root) : this.repoRoot;
    const dir = mkdtempSync(join(tmpdir(), "scip-crw-"));
    const indexPath = join(dir, "index.scip");
    // --infer-tsconfig writes a tsconfig.json into the root if none exists;
    // clean it up so we don't leave an artifact in the reviewed tree.
    const tsconfigPath = join(absRoot, "tsconfig.json");
    const hadTsconfig = existsSync(tsconfigPath);
    const started = Date.now();
    try {
      try {
        if (job.language === "ts") {
          const binJs = resolveIndexerBin("@sourcegraph/scip-typescript", "scip-typescript");
          execFileSync(process.execPath, [binJs, "index", "--infer-tsconfig", "--output", indexPath], {
            cwd: absRoot,
            encoding: "utf8",
            maxBuffer: 256 * 1024 * 1024,
          });
        } else {
          throw new IndexError(`no indexer available for language '${job.language}' (root '${job.root || "."}')`);
        }
      } catch (e) {
        if (e instanceof IndexError) throw e;
        const err = e as Error & { stderr?: unknown };
        const stderr = err.stderr ? `\n${String(err.stderr).slice(-2000)}` : "";
        throw new IndexError(`${job.language} indexer failed for root '${job.root || "."}': ${err.message}${stderr}`);
      }
      this.proto ??= await protobuf.load(SCIP_PROTO);
      const Index = this.proto.lookupType("scip.Index");
      const idx = Index.toObject(Index.decode(readFileSync(indexPath)), { longs: Number, defaults: false }) as ScipIndex;
      const docs = rerootDocuments(idx.documents ?? [], job.root, absRoot);
      if (docs.length === 0 && job.hasSources) {
        throw new IndexError(
          `${job.language} indexer produced an empty index for root '${job.root || "."}', which contains ${job.language} sources`
        );
      }
      console.log(`scip: ${job.language} root '${job.root || "."}' — ${docs.length} documents in ${Date.now() - started}ms`);
      return docs;
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (job.language === "ts" && !hadTsconfig) rmSync(tsconfigPath, { force: true });
    }
  }
}

function resolveIndexerBin(pkgName: string, binName: string): string {
  const pkgPath = require.resolve(`${pkgName}/package.json`);
  const pkg = require(`${pkgName}/package.json`) as { bin: string | Record<string, string> };
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin[binName];
  return join(dirname(pkgPath), rel);
}
```

(The closing brace above ends the class; `resolveIndexerBin` replaces `resolveScipTypescriptBin` at module level. Delete `resolveScipTypescriptBin`.)

- [ ] **Step 4: Run the full server suite**

Run: `pnpm vitest run packages/server/test/`
Expected: PASS — including the pre-existing scip-cache, graph, and e2e tests (the e2e/graph tests exercise the TS path end-to-end; this repo discovers a single ts root at `""`, so indexing behavior is unchanged).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm -r typecheck` — expected clean.

```bash
git add packages/server/src/graph/scip.ts packages/server/test/scip-cache.test.ts
git commit -m "feat(server): multi-root indexer orchestration with per-job subtree caching"
```

---

### Task 5: scip-python runner + integration test

Add `@sourcegraph/scip-python` (npm package, same acquisition path as scip-typescript — it's Pyright-based, runs under Node) and the `py` branch of `runIndexer`. The integration test builds a tiny two-file Python repo and asserts a real flow comes out — this is the empirical check that `enclosingRange` + `().`-suffixed symbols survive the whole pipeline, not just the probe.

**Files:**
- Modify: `packages/server/package.json` (dependency)
- Modify: `packages/server/src/graph/scip.ts` (`runIndexer`, py branch)
- Test: `packages/server/test/scip-python.test.ts` (new)

**Interfaces:**
- Consumes: `runIndexer` structure from Task 4.
- Produces: working `py` indexer jobs end-to-end.

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @crw/server add @sourcegraph/scip-python`
Expected: `packages/server/package.json` gains the dependency; lockfile updates.

- [ ] **Step 2: Write the failing integration test**

Create `packages/server/test/scip-python.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScipGraphProvider } from "../src/graph/scip.js";

// Real scip-python run over a tiny fixture — slow-ish (~seconds), so one test.
describe("scip-python integration", () => {
  it("indexes a python root and derives a call flow with repo-relative paths", { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "crw-py-"));
    try {
      const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
      git("init", "-b", "main");
      git("config", "user.email", "t@t");
      git("config", "user.name", "t");
      mkdirSync(join(dir, "svc"));
      writeFileSync(join(dir, "svc", "pyproject.toml"), '[project]\nname = "svc"\nversion = "0.0.1"\n');
      writeFileSync(join(dir, "svc", "helper.py"), 'def greet(name: str) -> str:\n    return "hello " + name\n');
      writeFileSync(
        join(dir, "svc", "app.py"),
        'from helper import greet\n\n\ndef main() -> None:\n    print(greet("world"))\n'
      );
      git("add", ".");
      git("commit", "-m", "init");

      const provider = new ScipGraphProvider({ repoRoot: dir });
      const flows = await provider.getFlows();
      const main = flows.find((f) => f.name === "main");
      expect(main, `expected a 'main' flow, got: ${flows.map((f) => f.name).join(", ")}`).toBeDefined();
      expect(main!.steps.map((s) => s.label)).toEqual(["main", "greet"]);
      expect(main!.steps.map((s) => s.file)).toEqual(["svc/app.py", "svc/helper.py"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails for the right reason**

Run: `pnpm vitest run packages/server/test/scip-python.test.ts`
Expected: FAIL with `IndexError: no indexer available for language 'py'` (fixture has only a py root; discovery finds it; Task 4's `runIndexer` has no py branch yet).

- [ ] **Step 4: Implement the py branch**

In `runIndexer` (Task 4's code), replace the `else { throw new IndexError(...) }` arm with:

```ts
        } else if (job.language === "py") {
          const binJs = resolveIndexerBin("@sourcegraph/scip-python", "scip-python");
          const projectName = job.root.replace(/[^A-Za-z0-9._-]+/g, "-") || "repo";
          execFileSync(process.execPath, [binJs, "index", ".", "--output", indexPath, "--project-name", projectName], {
            cwd: absRoot,
            encoding: "utf8",
            maxBuffer: 256 * 1024 * 1024,
          });
        } else {
          throw new IndexError(`no indexer available for language '${job.language}' (root '${job.root || "."}')`);
        }
```

Note: scip-python resolves third-party imports best with the project's deps installed, but first-party edges (what the graph needs) work without them — verified in the 2026-07-15 probe. Don't add virtualenv detection here (roadmap open question 4, deferred).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/server/test/scip-python.test.ts`
Expected: PASS. If `greet` doesn't resolve cross-file, the fixture's `from helper import greet` didn't resolve — check scip-python stderr in the IndexError/console output before touching provider code (systematic-debugging).

- [ ] **Step 6: Run the full suite, typecheck, commit**

Run: `pnpm vitest run packages/server/test/` and `pnpm -r typecheck`
Expected: all PASS, clean typecheck.

```bash
git add packages/server/package.json pnpm-lock.yaml packages/server/src/graph/scip.ts packages/server/test/scip-python.test.ts
git commit -m "feat(server): scip-python indexer for python roots"
```

---

### Task 6: Fail loudly — surface `IndexError` in session creation

Session creation already 400s with `phase` for `GitError`; give `IndexError` the same treatment so a broken indexer can never silently produce an orphan-only session (the exact failure mode the P0 wave stamped out for git).

**Files:**
- Modify: `packages/server/src/routes/sessions.ts` (catch block, ~line 105-108)
- Test: `packages/server/test/routes.test.ts` (append inside the `POST /api/sessions` describe)

**Interfaces:**
- Consumes: `IndexError` (Task 3).
- Produces: `POST /api/sessions` → `400 { error, phase: "index" }` when any indexer job fails; no session row persisted.

- [ ] **Step 1: Write the failing test**

Append to the `POST /api/sessions` describe block in `packages/server/test/routes.test.ts` (add `import { IndexError } from "../src/graph/scip.js";` and `import type { ChangeSubgraph } from "../src/graph/provider.js";` to the imports):

```ts
  it("fails with 400 and phase 'index' when an indexer breaks, persisting nothing", async () => {
    class IndexBreakingStub extends StubGraphProvider {
      override async getChangeSubgraph(): Promise<ChangeSubgraph> {
        throw new IndexError("py indexer failed for root 'svc': exit 1");
      }
    }
    const app2 = createApp({ db, graphProvider: new IndexBreakingStub(), repoRoot: fixtureRoot });
    const res = await app2.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.phase).toBe("index");
    expect(body.error).toMatch(/py indexer failed/);
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM review_sessions").get() as { n: number };
    expect(n).toBe(0);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/server/test/routes.test.ts`
Expected: the new test FAILS — the route rethrows `IndexError` (500), not a 400 with `phase: "index"`.

- [ ] **Step 3: Implement**

In `packages/server/src/routes/sessions.ts`:

Add to imports:

```ts
import { IndexError } from "../graph/scip.js";
```

Extend the catch block (currently `if (e instanceof GitError) ...; throw e;`):

```ts
    } catch (e) {
      if (e instanceof GitError) return c.json({ error: e.message, phase: e.phase }, 400);
      if (e instanceof IndexError) return c.json({ error: e.message, phase: e.phase }, 400);
      throw e;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/server/test/routes.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Full suite, typecheck, commit**

Run: `pnpm vitest run packages/server/test/ packages/skill/test/` and `pnpm -r typecheck`
Expected: all PASS.

```bash
git add packages/server/src/routes/sessions.ts packages/server/test/routes.test.ts
git commit -m "feat(server): surface indexer failures as index-phase session errors"
```

---

### Task 7: Checkpoint — dogfood on the aivo `introspector-obo` diff

Manual verification (the roadmap's Phase 1 exit criterion): on the aivo repo, the Python MCP half of the OBO diff (config → backend_client → server) must produce affected flows and relations, while the Java half stays residual-only.

**Files:** none (verification only; findings go in the session/notes, not the repo).

- [ ] **Step 1: Build and start the hub against aivo**

```bash
pnpm build
cd ~/Projects/<aivo-checkout>   # the checkout with the introspector-obo branch checked out
CRW_DB_PATH=/tmp/crw-dogfood.db PORT=3456 node ~/Projects/pareto/rewiew-walkthrough-opencode/packages/server/dist/index.js
```

Expected startup log: one `scip: ts root ...` line per TS root and one `scip: py root ...` line per Python root after the first session request (indexing is lazy).

- [ ] **Step 2: Create a session for the OBO diff**

```bash
curl -s -X POST http://localhost:3456/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"branch": "HEAD", "baseRef": "main"}' | head -c 2000
```

Expected: a session with nodes whose `file` paths span both `mcp/...py` and TS files; Java files appear only as residual pseudo-nodes.

- [ ] **Step 3: Verify flows in the web UI**

Open `http://localhost:3456` in the already-running Playwright browser. Expected: the Python config → backend_client → server chain shows as an affected flow with relations; Java files listed residual-only. Capture a screenshot for the record.

- [ ] **Step 4: Verify the cache split**

Touch one Python file in aivo (add a blank line), create a second session: only the py root re-indexes (one `scip: py root` log line, no `scip: ts root` line). Revert the touch.

- [ ] **Step 5: Record the result**

Append a short "Phase 1 checkpoint" note (date, what worked, anything off) to `docs/superpowers/plans/2026-07-15-polyglot-provider-roadmap.md` under the Phase 1 section, and commit:

```bash
git add docs/superpowers/plans/2026-07-15-polyglot-provider-roadmap.md
git commit -m "docs: phase 1 checkpoint — python flows on the aivo obo dogfood"
```

---

## Self-review notes (spec → plan)

- Roadmap "language-root discovery ... env/config override" → Task 2 (discovery) + Task 4 (`SCIP_LANGS` filter). Java markers detected, excluded by default. ✓
- "Run scip-python per Python root ... same acquisition path" → Task 5. ✓
- "Merge indexes ... re-rooted to repo-relative" → Task 3 (pure) + Task 4 (wired). `buildGraphFromIndex` verified index-shape-agnostic: it only reads `documents[].relativePath/occurrences` (scip.ts:300-351). ✓
- "Cache per (indexer, root, content-fingerprint)" → Task 1 (fingerprint, answers open question 1 via tree-sha + `git diff HEAD -- <root>` + untracked) + Task 4 (job cache). ✓
- "Fail loudly ... extend the GitError-style phase errors with an `index` phase" → Task 3 (error type) + Task 4 (throw sites: non-zero exit, empty index with sources) + Task 6 (route surface). ✓
- "Checkpoint: aivo introspector-obo dogfood" → Task 7. ✓
- Open question 2 (overlapping roots) — resolved minimally: same-language nesting deduped in Task 2; cross-language overlap is allowed by design.
- Open question 3 (session diagnostics) — deliberately minimal in this phase: per-job log lines + index-phase errors. The response-shape diagnostics stay with the deferred P2 item / plugin work.
