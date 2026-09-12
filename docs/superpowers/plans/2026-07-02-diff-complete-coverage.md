# Diff-Complete Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every changed line appears in ≥1 review unit — diff hunks not covered by any graph node become file-anchored pseudo-nodes.

**Architecture:** Pure interval subtraction in `diff.ts`; a `computeResiduals` helper in a new `residuals.ts` walks `git diff --name-only` files, subtracts stored node spans from changed ranges, and emits one pseudo-node per file. Session creation stores them as ordinary node rows (`stableId: "file-residual:<path>"`), so orphan detection, coverage, and the diff view work unmodified. `AppContext` gains an explicit `repoRoot` so tests pin git to a fixture. Spec: `docs/superpowers/specs/2026-07-02-diff-complete-coverage-design.md`.

**Tech Stack:** TypeScript strict, Hono routes, vitest with temp git fixture repos (pattern from `test/scip-cache.test.ts`).

## Global Constraints

- Pseudo-node stableId scheme: `file-residual:<repo-relative-path>` — exactly one per file.
- Label: `<basename> (module scope)` when the file has real nodes, `<basename>` when not, `<basename> (deleted)` for deletions.
- `changedFiles` / `fileChangedRanges` git failure → skip silently (no throw), matching existing `diff.ts` behavior.
- Existing routes tests must keep passing with a pinned non-git `repoRoot` (no accidental dependence on this repo's live diff).

---

### Task 1: `subtractRanges` (pure interval subtraction)

**Files:**
- Modify: `packages/server/src/diff.ts`
- Test: `packages/server/test/diff.test.ts` (extend)

**Interfaces:**
- Produces: `subtractRanges(ranges: LineRange[], spans: LineRange[]): LineRange[]` — parts of `ranges` not covered by `spans`, in order, non-overlapping input assumed for `ranges`.

- [ ] **Step 1: Write the failing test** — append to `diff.test.ts`:

```ts
import { subtractRanges } from "../src/diff.js";

describe("subtractRanges", () => {
  const r = (start: number, end: number) => ({ start, end });
  it("returns ranges untouched when spans are disjoint", () => {
    expect(subtractRanges([r(1, 5)], [r(10, 20)])).toEqual([r(1, 5)]);
  });
  it("removes a fully covered range", () => {
    expect(subtractRanges([r(12, 15)], [r(10, 20)])).toEqual([]);
  });
  it("trims overlap at both ends", () => {
    expect(subtractRanges([r(5, 25)], [r(10, 20)])).toEqual([r(5, 9), r(21, 25)]);
  });
  it("subtracts multiple spans from one range", () => {
    expect(subtractRanges([r(1, 30)], [r(5, 10), r(20, 25)])).toEqual([r(1, 4), r(11, 19), r(26, 30)]);
  });
  it("handles multiple input ranges", () => {
    expect(subtractRanges([r(1, 3), r(8, 12)], [r(2, 9)])).toEqual([r(1, 1), r(10, 12)]);
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter @srev/server exec vitest run test/diff.test.ts` — Expected: FAIL (`subtractRanges` not exported).

- [ ] **Step 3: Implement** in `diff.ts`:

```ts
/** Parts of `ranges` not covered by any of `spans`. */
export function subtractRanges(ranges: LineRange[], spans: LineRange[]): LineRange[] {
  const out: LineRange[] = [];
  for (const range of ranges) {
    let pieces: LineRange[] = [range];
    for (const s of spans) {
      const next: LineRange[] = [];
      for (const p of pieces) {
        if (s.end < p.start || s.start > p.end) { next.push(p); continue; }
        if (s.start > p.start) next.push({ start: p.start, end: s.start - 1 });
        if (s.end < p.end) next.push({ start: s.end + 1, end: p.end });
      }
      pieces = next;
    }
    out.push(...pieces);
  }
  return out;
}
```

- [ ] **Step 4: Run** the same test file — Expected: PASS.

- [ ] **Step 5: Commit** `git add packages/server/src/diff.ts packages/server/test/diff.test.ts && git commit -m "feat(server): subtractRanges interval helper"`

### Task 2: `changedFiles` + shared `isTestFile`

**Files:**
- Modify: `packages/server/src/diff.ts` (add `changedFiles`), `packages/server/src/util.ts` (add `isTestFile`), `packages/server/src/graph/scip.ts` (import `isTestFile` from util, delete local copy)
- Test: `packages/server/test/residuals.test.ts` (new — fixture-repo helper shared with Task 3)

**Interfaces:**
- Produces: `changedFiles(baseRef: string, root?: string): string[]` (repo-relative paths, `[]` on git failure); `isTestFile(p: string): boolean` in `util.ts`.

- [ ] **Step 1: Write the failing test** — create `packages/server/test/residuals.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFiles } from "../src/diff.js";

let dir: string;
const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "srev-resid-"));
  git("init", "-b", "main");
  git("config", "user.email", "t@t"); git("config", "user.name", "t");
  writeFileSync(join(dir, "types.ts"), "export interface Order {\n  id: string;\n}\n");
  writeFileSync(join(dir, "orders.ts"), "export function handle() {\n  return 1;\n}\n");
  writeFileSync(join(dir, "gone.ts"), "export const X = 1;\n");
  git("add", "."); git("commit", "-m", "base");
  // working-tree changes vs main:
  writeFileSync(join(dir, "types.ts"), "export interface Order {\n  id: string;\n  total: number;\n}\n");
  writeFileSync(join(dir, "orders.ts"), "import { z } from \"zod\";\nexport function handle() {\n  return 2;\n}\n");
  unlinkSync(join(dir, "gone.ts"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("changedFiles", () => {
  it("lists files changed vs baseRef", () => {
    expect(changedFiles("main", dir).sort()).toEqual(["gone.ts", "orders.ts", "types.ts"]);
  });
  it("returns [] when git fails", () => {
    expect(changedFiles("main", "/nonexistent-root")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter @srev/server exec vitest run test/residuals.test.ts` — Expected: FAIL (`changedFiles` not exported).

- [ ] **Step 3: Implement.** In `diff.ts`:

```ts
/** Repo-relative paths changed vs baseRef ([] on git failure). */
export function changedFiles(baseRef: string, root: string = repoRoot()): string[] {
  try {
    const raw = execFileSync("git", ["diff", "--name-only", baseRef], {
      cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    });
    return raw.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
```

In `util.ts` add (moved verbatim from `scip.ts`):

```ts
export const isTestFile = (p: string) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)(test|tests|__tests__)\//.test(p);
```

In `scip.ts` delete the local `isTestFile` const and add `import { isTestFile } from "../util.js";`.

- [ ] **Step 4: Run** `pnpm --filter @srev/server exec vitest run` — Expected: PASS (all server tests, including scip ones).

- [ ] **Step 5: Commit** `git add -A packages/server && git commit -m "feat(server): changedFiles helper; share isTestFile via util"`

### Task 3: `computeResiduals`

**Files:**
- Create: `packages/server/src/residuals.ts`
- Test: `packages/server/test/residuals.test.ts` (extend)

**Interfaces:**
- Consumes: `changedFiles`, `fileChangedRanges`, `subtractRanges` (diff.ts), `isTestFile` (util.ts).
- Produces: `computeResiduals(baseRef: string, nodeSpans: Map<string, LineRange[]>, root: string): ResidualNode[]` where `ResidualNode = { stableId, label, file, startLine, endLine, isTest }`.

- [ ] **Step 1: Write the failing test** — append to `residuals.test.ts` (uses the same fixture repo):

```ts
import { computeResiduals } from "../src/residuals.js";

describe("computeResiduals", () => {
  it("emits a whole-file pseudo-node for a changed file with no graph nodes", () => {
    const res = computeResiduals("main", new Map(), dir);
    const types = res.find((r) => r.file === "types.ts")!;
    expect(types.stableId).toBe("file-residual:types.ts");
    expect(types.label).toBe("types.ts");
    expect(types.startLine).toBeGreaterThan(0);
  });

  it("subtracts node spans and labels module-scope residuals", () => {
    // orders.ts change: import line 1 (residual) + body line 3 (covered by the node span)
    const spans = new Map([["orders.ts", [{ start: 2, end: 4 }]]]);
    const res = computeResiduals("main", spans, dir);
    const orders = res.find((r) => r.file === "orders.ts")!;
    expect(orders.label).toBe("orders.ts (module scope)");
    expect(orders.startLine).toBe(1);
    expect(orders.endLine).toBe(1);
  });

  it("emits no pseudo-node when node spans cover all hunks", () => {
    const spans = new Map([["orders.ts", [{ start: 1, end: 10 }]]]);
    const res = computeResiduals("main", spans, dir);
    expect(res.find((r) => r.file === "orders.ts")).toBeUndefined();
  });

  it("marks a deleted file", () => {
    const res = computeResiduals("main", new Map(), dir);
    const gone = res.find((r) => r.file === "gone.ts")!;
    expect(gone.label).toBe("gone.ts (deleted)");
    expect(gone.startLine).toBe(0);
    expect(gone.endLine).toBe(0);
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `packages/server/src/residuals.ts`:

```ts
import { basename } from "node:path";
import { changedFiles, fileChangedRanges, subtractRanges, type LineRange } from "./diff.js";
import { isTestFile } from "./util.js";

export interface ResidualNode {
  stableId: string;
  label: string;
  file: string;
  startLine: number;
  endLine: number;
  isTest: boolean;
}

/**
 * Diff hunks not covered by any stored node's span, folded to one pseudo-node
 * per file (bounding box). Guarantees changed lines outside the graph — types,
 * imports, configs, non-indexed files — still enter the review universe.
 */
export function computeResiduals(
  baseRef: string,
  nodeSpans: Map<string, LineRange[]>,
  root: string
): ResidualNode[] {
  const out: ResidualNode[] = [];
  for (const file of changedFiles(baseRef, root)) {
    const ranges = fileChangedRanges(baseRef, file, root);
    if (!ranges || ranges.length === 0) continue;
    const spans = nodeSpans.get(file) ?? [];
    const residual = subtractRanges(ranges, spans);
    if (residual.length === 0) continue;
    const start = Math.min(...residual.map((r) => r.start));
    const end = Math.max(...residual.map((r) => r.end));
    const deleted = end === 0; // pure deletion: hunks attribute to new line 0
    const suffix = deleted ? " (deleted)" : spans.length > 0 ? " (module scope)" : "";
    out.push({
      stableId: `file-residual:${file}`,
      label: `${basename(file)}${suffix}`,
      file,
      startLine: start,
      endLine: end,
      isTest: isTestFile(file),
    });
  }
  return out;
}
```

- [ ] **Step 4: Run** `pnpm --filter @srev/server exec vitest run test/residuals.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** `git add packages/server/src/residuals.ts packages/server/test/residuals.test.ts && git commit -m "feat(server): computeResiduals — uncovered hunks to pseudo-nodes"`

### Task 4: Store pseudo-nodes at session creation (`repoRoot` in AppContext)

**Files:**
- Modify: `packages/server/src/app.ts` (AppContext + default), `packages/server/src/routes/sessions.ts` (POST handler), `packages/server/test/routes.test.ts` (pin repoRoot; add integration test)

**Interfaces:**
- Consumes: `computeResiduals` (Task 3).
- Produces: `AppContext.repoRoot: string` (defaulted in `createApp` via `repoRoot()` from diff.ts); session POST stores residual nodes with `changeStatus: "changed"`, `reviewStatus: "unreviewed"`.

- [ ] **Step 1: Pin repoRoot in existing tests and write the failing integration test.**

In `routes.test.ts`, change the setup so the app never reads this repo's live diff:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fixtureRoot: string;
beforeEach(() => {
  db = createMemoryDatabase();
  fixtureRoot = mkdtempSync(join(tmpdir(), "srev-routes-")); // not a git repo → no diffs
  app = createApp({ db, graphProvider: new StubGraphProvider(), repoRoot: fixtureRoot });
});
afterEach(() => { db.close(); rmSync(fixtureRoot, { recursive: true, force: true }); });
```

Caveat: a non-git temp dir under `/tmp` — `git diff` walks up and finds no repo → all helpers return null/[] → behavior identical to today for the stub fixtures.

Add the integration test (new describe at the end):

```ts
describe("residual pseudo-nodes", () => {
  it("stores a file-residual node for changed lines outside any graph node", async () => {
    const { execFileSync } = await import("node:child_process");
    const { writeFileSync } = await import("node:fs");
    const g = (...a: string[]) => execFileSync("git", a, { cwd: fixtureRoot, encoding: "utf8" });
    g("init", "-b", "main");
    g("config", "user.email", "t@t"); g("config", "user.name", "t");
    writeFileSync(join(fixtureRoot, "config.json"), "{\n  \"a\": 1\n}\n");
    g("add", "."); g("commit", "-m", "base");
    writeFileSync(join(fixtureRoot, "config.json"), "{\n  \"a\": 2\n}\n");

    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const nr = await app.request(`/api/sessions/${session.id}/nodes`);
    const { nodes } = await nr.json();
    const residual = nodes.find((n: any) => n.stableId === "file-residual:config.json");
    expect(residual).toBeDefined();
    expect(residual.changeStatus).toBe("changed");
    expect(residual.label).toBe("config.json");

    // and it participates in coverage
    const sres = await app.request(`/api/sessions/${session.id}`);
    const { coverage } = await sres.json();
    expect(coverage.changedTotal).toBe(3); // 2 stub changed nodes + 1 residual
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter @srev/server exec vitest run test/routes.test.ts` — Expected: FAIL (`repoRoot` not in AppContext / no residual node).

- [ ] **Step 3: Implement.** `app.ts`:

```ts
import { repoRoot as defaultRepoRoot } from "./diff.js";

export interface AppContext {
  db: DB;
  graphProvider: GraphProvider;
  repoRoot?: string;
}

export function createApp(ctx: AppContext) {
  const resolved = { ...ctx, repoRoot: ctx.repoRoot ?? defaultRepoRoot() };
  // ...pass `resolved` to all route factories instead of ctx...
}
```

`sessions.ts` POST — after the `keptNodes` loop, before edge insertion:

```ts
import { computeResiduals } from "../residuals.js";
import type { LineRange } from "../diff.js";

const spansByFile = new Map<string, LineRange[]>();
for (const n of keptNodes) {
  const spans = spansByFile.get(n.file) ?? [];
  spans.push({ start: n.startLine, end: n.endLine });
  spansByFile.set(n.file, spans);
}
for (const r of computeResiduals(body.baseRef, spansByFile, ctx.repoRoot!)) {
  createNode(ctx.db, {
    sessionId: session.id, stableId: r.stableId,
    label: r.label, file: r.file, startLine: r.startLine, endLine: r.endLine,
    changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null,
    isTest: r.isTest,
  });
}
```

Also: `reconcileSubgraph` calls `fileChangedRanges(baseRef, n.file)` with the default root — thread `ctx.repoRoot` through as a third argument so refinement uses the same repo.

- [ ] **Step 4: Run** `pnpm --filter @srev/server exec vitest run` — Expected: PASS (all).

- [ ] **Step 5: Commit** `git add -A packages/server && git commit -m "feat(server): residual pseudo-nodes at session creation; explicit repoRoot in AppContext"`

### Task 5: `kind: "file"` in the change summary

**Files:**
- Modify: `packages/server/src/routes/changes.ts`
- Test: `packages/server/test/routes.test.ts` (extend the residual describe)

**Interfaces:**
- Produces: change-summary records for pseudo-nodes carry `kind: "file"`; other kinds unchanged.

- [ ] **Step 1: Write the failing test** — inside the `residual pseudo-nodes` describe, after the existing assertions (same session setup; extract the session-creation lines into the describe's `beforeEach` if cleaner):

```ts
  it("reports kind 'file' in the change summary", async () => {
    // same fixture-repo session as above
    const res = await app.request(`/api/sessions/${sessionId}/changes`);
    const { changes } = await res.json();
    const residual = changes.find((ch: any) => ch.stableId === "file-residual:config.json");
    expect(residual.kind).toBe("file");
  });
```

- [ ] **Step 2: Run** — Expected: FAIL (kind is "function").

- [ ] **Step 3: Implement** — in `changes.ts` replace the kind heuristic and its comment:

```ts
      // Heuristic: SCIP sets no symbol kind. Residual pseudo-nodes are tagged by their
      // stableId scheme; beyond that only functions/methods reach this point (types/
      // namespaces are filtered upstream when building graph nodes).
      const kind = n.stableId.startsWith("file-residual:")
        ? "file"
        : n.isTest ? "test" : n.stableId.includes("#") ? "method" : "function";
```

- [ ] **Step 4: Run** `pnpm --filter @srev/server exec vitest run test/routes.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** `git add -A packages/server && git commit -m "feat(server): kind 'file' for residual changes in change summary"`

### Task 6: Skill guidance for `kind: "file"` orphans

**Files:**
- Modify: `packages/skill/skill.md`

- [ ] **Step 1: Edit** — in the "Building the review plan" steps, extend step 3:

```markdown
3. Group the `orphans` into orphan-units by shared purpose (e.g. "validation helpers",
   "test fixtures"), using each change's `kind`/`file`/`signature` from `changes`.
   Changes with `kind: "file"` are module-scope / non-code-graph changes (types,
   imports, configs, dependency manifests) — group them by purpose (e.g. "dependency
   & config changes", "type/contract edits") and order them early: they are the
   foundations the flows sit on.
```

- [ ] **Step 2: Run** `pnpm test` — Expected: PASS (docs-only change; guard against accidental breakage).

- [ ] **Step 3: Commit** `git add packages/skill/skill.md && git commit -m "docs(skill): guidance for grouping kind:'file' residual changes"`
