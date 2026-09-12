# Agent DX Wave 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold the ad-hoc scripting a planning agent needs today (empty-tree bases, flow-merge math, orphan triage, stableId hand-listing, intent gathering) into `srev` itself.

**Architecture:** Four independent features plus a docs/packaging task. Server-side: tree-ish base refs, commit subjects in the changes payload, glob-based orphan-unit resolution at plan submit. CLI-side: `--base empty` alias, `mergeSuggestions` and directory-grouped orphans in `srev context` (pure functions in `api.ts`, composed in `cli.ts`).

**Tech Stack:** TypeScript strict, Hono, zod, node:sqlite, Vitest. No new dependencies — glob matching is a ~20-line converter, not a package.

**Origin:** Findings from dogfooding a whole-repo review session (2026-07-26): every jq invocation the planning agent wrote is a missing `srev` affordance.

## Global Constraints

- Node >= 22.13; no new runtime dependencies.
- JSON on stdout; `--pretty` for humans. CLI never touches SQLite.
- The committed plugin bundle (`plugin/dist/*`, `plugin/web/*`) must be rebuilt in the same change as any runtime change (CI freshness guard).
- Plan version bump: `plugin/.claude-plugin/plugin.json` 0.3.0 → 0.4.0.
- Follow existing test patterns: fixture git repos via `mkdtempSync` (see `packages/server/test/routes.test.ts`), mocked `fetch` for skill api tests.

---

### Task 1: Tree-ish base refs — whole-repo review sessions

The empty tree (`4b825dc642cb6eb9a060e54bf8d69288fbee4904`) is a valid `git diff` base but `resolveRef` peels `^{commit}` and rejects it. Every downstream consumer (`changedFilesStrict`, `fileChangedRanges`, `getNodeDiff`, `fileUnifiedDiff`) passes baseRef straight to `git diff`, which accepts tree-ish. Accept tree-ish at the gate; add a CLI alias so agents never need the magic hash.

**Files:**
- Modify: `packages/server/src/diff.ts:173-180` (resolveRef), add `EMPTY_TREE_SHA` export
- Modify: `packages/skill/src/api.ts` (add `EMPTY_TREE_SHA`, `resolveBaseAlias`)
- Modify: `packages/skill/src/cli.ts:95-98` (cmdSessionCreate uses alias), USAGE line
- Test: `packages/server/test/diff.test.ts`, `packages/server/test/routes.test.ts`, `packages/skill/test/api.test.ts`

**Interfaces:**
- Produces: `EMPTY_TREE_SHA: string` (both packages, duplicated constant — the packages don't share code); `resolveBaseAlias(ref: string): string` in skill api.
- `resolveRef` behavior change: commit-ish OR tree-ish resolves; blobs/garbage still null.

- [x] **Step 1: Write failing tests**

`packages/server/test/diff.test.ts` (inside the existing `resolveRef` describe, using `fixtureRepo`):

```ts
it("resolves the empty tree (tree-ish base for whole-repo reviews)", () => {
  expect(resolveRef(EMPTY_TREE_SHA, fixtureRepo)).toBe(EMPTY_TREE_SHA);
});
it("still rejects blob refs", () => {
  // a.txt exists at HEAD; HEAD:a.txt is a blob, not commit-ish or tree-ish
  expect(resolveRef("HEAD:a.txt", fixtureRepo)).toBeNull();
});
```

`packages/server/test/routes.test.ts` (POST /api/sessions describe):

```ts
it("accepts the empty tree as baseRef (whole-repo review)", async () => {
  const res = await app.request("/api/sessions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branch: "HEAD", baseRef: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" }),
  });
  expect(res.status).toBe(200);
});
```

`packages/skill/test/api.test.ts`:

```ts
describe("resolveBaseAlias", () => {
  it("maps 'empty' to the empty tree sha", () => {
    expect(resolveBaseAlias("empty")).toBe(EMPTY_TREE_SHA);
  });
  it("passes ordinary refs through", () => {
    expect(resolveBaseAlias("main")).toBe("main");
  });
});
```

- [x] **Step 2: Run tests, verify they fail** (`pnpm --filter @srev/server test -- diff`, etc.)

- [x] **Step 3: Implement**

`packages/server/src/diff.ts`:

```ts
/** git's well-known empty tree — a valid diff base meaning "nothing", so a
 *  session with this base reviews the entire codebase. */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Resolves `ref` to a full commit or tree sha, or null if it is neither.
 *  Tree-ish is accepted because every downstream use is `git diff <base>`,
 *  which takes tree-ish — enabling empty-tree (whole-repo) bases. */
export function resolveRef(ref: string, root: string = repoRoot()): string | null {
  for (const peel of ["commit", "tree"] as const) {
    try {
      return execFileSync("git", ["rev-parse", "--verify", `${ref}^{${peel}}`], { cwd: root, encoding: "utf8", ...QUIET }).trim();
    } catch { /* try next peel */ }
  }
  return null;
}
```

Note: `HEAD^{tree}` succeeds for commit refs too, but the commit peel runs first so commit refs keep resolving to commit shas.

`packages/skill/src/api.ts`:

```ts
/** git's well-known empty tree; `srev session create --base empty` maps here. */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Base-ref conveniences: "empty" = the empty tree (whole-repo review). */
export function resolveBaseAlias(ref: string): string {
  return ref === "empty" ? EMPTY_TREE_SHA : ref;
}
```

`packages/skill/src/cli.ts` cmdSessionCreate: `const baseRef = resolveBaseAlias(required(flags, "base"));`
USAGE: `srev session create --branch <b> --base <ref|empty> [--open]`

- [x] **Step 4: Run tests, verify pass**
- [x] **Step 5: Commit** `feat(server,srev): tree-ish base refs — --base empty reviews the whole repo`

---

### Task 2: Commit subjects in the changes payload

Intent gathering is a skill step today (`git log --format=%s`). The server knows the range; serve it.

**Files:**
- Modify: `packages/server/src/diff.ts` (add `commitSubjects`)
- Modify: `packages/server/src/routes/changes.ts` (include in response)
- Modify: `packages/skill/src/api.ts:133-135` (getChanges type), `packages/skill/src/cli.ts:181-189` (cmdContext passthrough)
- Test: `packages/server/test/diff.test.ts`, `packages/server/test/routes.test.ts`

**Interfaces:**
- Produces: `commitSubjects(baseRef: string, root?: string, limit?: number): string[]` — newest first, `[]` on git failure.
- Changes endpoint response becomes `{ changes, commitSubjects }`.

- [x] **Step 1: Failing tests**

`packages/server/test/diff.test.ts`:

```ts
describe("commitSubjects", () => {
  it("lists subjects newest-first for base..HEAD", () => {
    // fixtureRepo has one commit "init"; add another
    const git = (...a: string[]) => execFileSync("git", a, { cwd: fixtureRepo, encoding: "utf8" });
    writeFileSync(join(fixtureRepo, "b.txt"), "two\n");
    git("add", "."); git("commit", "-m", "second");
    expect(commitSubjects("HEAD~1", fixtureRepo)).toEqual(["second"]);
  });
  it("falls back to full history for a tree-ish base (empty tree)", () => {
    expect(commitSubjects(EMPTY_TREE_SHA, fixtureRepo).at(-1)).toBe("init");
  });
  it("returns [] outside a repo", () => {
    expect(commitSubjects("HEAD", emptyTmpDir)).toEqual([]);
  });
});
```

`packages/server/test/routes.test.ts` (changes endpoint test): assert `body.commitSubjects` is an array containing `"init"`.

- [x] **Step 2: Run, verify fail**
- [x] **Step 3: Implement**

`packages/server/src/diff.ts`:

```ts
/**
 * Commit subjects in baseRef..HEAD, newest first, capped at `limit` — intent
 * input for plan authoring. A tree-ish base (e.g. the empty tree) has no
 * commit range, so fall back to full HEAD history: for the empty tree that
 * IS the range. [] when git fails entirely.
 */
export function commitSubjects(baseRef: string, root: string = repoRoot(), limit = 50): string[] {
  const log = (range: string) =>
    execFileSync("git", ["log", "--format=%s", `--max-count=${limit}`, range], { cwd: root, encoding: "utf8", ...QUIET })
      .split("\n").filter(Boolean);
  try {
    return log(`${baseRef}..HEAD`);
  } catch {
    try { return log("HEAD"); } catch { return []; }
  }
}
```

`packages/server/src/routes/changes.ts`: `return c.json({ changes, commitSubjects: commitSubjects(session.baseRef, ctx.repoRoot) });`

`packages/skill/src/api.ts`: `getChanges` return type `Promise<{ changes: unknown[]; commitSubjects?: string[] }>`.

`packages/skill/src/cli.ts` cmdContext: destructure `commitSubjects` from getChanges and spread into both compact and `--full` output.

- [x] **Step 4: Run, verify pass**
- [x] **Step 5: Commit** `feat(server): commit subjects in the changes payload — intent input without git log`

---

### Task 3: Merge suggestions in `srev context`

The skill's merge guideline (shared changed ids ≥ half the smaller flow's set) is mechanical. Compute it CLI-side from data `srev context` already fetches.

**Files:**
- Modify: `packages/skill/src/api.ts` (add `suggestMerges`)
- Modify: `packages/skill/src/cli.ts` (cmdContext adds `mergeSuggestions` to compact output)
- Test: `packages/skill/test/api.test.ts`

**Interfaces:**
- Produces:

```ts
export interface MergeSuggestion {
  entryStableIds: string[];   // ready to paste as flowEntryStableIds
  names: string[];
  pairs: { a: string; b: string; shared: number; smaller: number }[];  // evidence, by flow name
}
export function suggestMerges(
  flows: { entryStableId: string; name: string; changedStableIds: string[] }[]
): MergeSuggestion[]
```

Pairs qualify when `shared * 2 >= min(|A|, |B|)` and `shared > 0`; qualifying pairs union into connected components; only components of ≥ 2 flows are returned.

- [x] **Step 1: Failing tests** (`packages/skill/test/api.test.ts`)

```ts
describe("suggestMerges", () => {
  const flow = (entry: string, changed: string[]) => ({ entryStableId: entry, name: entry, changedStableIds: changed });
  it("groups flows sharing at least half of the smaller changed set", () => {
    const flows = [flow("a", ["x", "y", "z"]), flow("b", ["x", "y", "q"]), flow("c", ["p"])];
    const s = suggestMerges(flows);
    expect(s).toHaveLength(1);
    expect(s[0].entryStableIds).toEqual(["a", "b"]);
    expect(s[0].pairs).toEqual([{ a: "a", b: "b", shared: 2, smaller: 3 }]);
  });
  it("chains transitively into one component", () => {
    const flows = [flow("a", ["1", "2"]), flow("b", ["2", "3"]), flow("c", ["3", "4"])];
    expect(suggestMerges(flows)[0].entryStableIds).toEqual(["a", "b", "c"]);
  });
  it("suggests nothing for disjoint flows", () => {
    expect(suggestMerges([flow("a", ["1"]), flow("b", ["2"])])).toEqual([]);
  });
});
```

- [x] **Step 2: Run, verify fail**
- [x] **Step 3: Implement** in `api.ts`:

```ts
/** Mechanical merge candidates per the skill guideline: two flows belong in one
 *  multi-entry unit when they share >= half of the smaller flow's changed set.
 *  Qualifying pairs union into components; the LLM keeps label/order judgment. */
export function suggestMerges(
  flows: { entryStableId: string; name: string; changedStableIds: string[] }[]
): MergeSuggestion[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  for (const f of flows) parent.set(f.entryStableId, f.entryStableId);
  const pairs: { aId: string; bId: string; a: string; b: string; shared: number; smaller: number }[] = [];
  for (let i = 0; i < flows.length; i++) {
    for (let j = i + 1; j < flows.length; j++) {
      const A = flows[i], B = flows[j];
      const bSet = new Set(B.changedStableIds);
      const shared = A.changedStableIds.filter((id) => bSet.has(id)).length;
      const smaller = Math.min(A.changedStableIds.length, B.changedStableIds.length);
      if (shared > 0 && shared * 2 >= smaller) {
        pairs.push({ aId: A.entryStableId, bId: B.entryStableId, a: A.name, b: B.name, shared, smaller });
        parent.set(find(A.entryStableId), find(B.entryStableId));
      }
    }
  }
  const groups = new Map<string, MergeSuggestion>();
  for (const f of flows) {
    const root = find(f.entryStableId);
    const g = groups.get(root) ?? { entryStableIds: [], names: [], pairs: [] };
    g.entryStableIds.push(f.entryStableId);
    g.names.push(f.name);
    groups.set(root, g);
  }
  for (const p of pairs) groups.get(find(p.aId))!.pairs.push({ a: p.a, b: p.b, shared: p.shared, smaller: p.smaller });
  return [...groups.values()].filter((g) => g.entryStableIds.length >= 2);
}
```

`cli.ts` cmdContext (compact branch): `mergeSuggestions: suggestMerges(compact.flows)` — insert after flows in output object.

- [x] **Step 4: Run, verify pass**
- [x] **Step 5: Commit** `feat(srev): context emits mergeSuggestions — the merge guideline, precomputed`

---

### Task 4: Directory-grouped orphans in compact context

203 flat orphans is triage work the CLI can pre-do. Compact context groups orphans by directory; `--full` keeps the flat dump.

**Files:**
- Modify: `packages/skill/src/api.ts:27-40` (compactContext returns `orphanGroups`)
- Test: `packages/skill/test/api.test.ts`, adjust any cli.test.ts assertions

**Interfaces:**
- `compactContext` return type changes: `orphans` → `orphanGroups: { dir: string; orphans: { stableId; label; file; residualKind? }[] }[]`, groups sorted by dir, entries sorted by file.

- [x] **Step 1: Failing test**

```ts
it("groups compact-context orphans by directory", () => {
  const orphans = [
    { stableId: "d1", label: "x.md", file: "docs/x.md" },
    { stableId: "d2", label: "y.md", file: "docs/y.md" },
    { stableId: "r1", label: "pkg", file: "package.json" },
  ];
  const { orphanGroups } = compactContext([], orphans as any);
  expect(orphanGroups.map((g) => g.dir)).toEqual([".", "docs"]);
  expect(orphanGroups[1].orphans.map((o) => o.stableId)).toEqual(["d1", "d2"]);
});
```

- [x] **Step 2: Run, verify fail**
- [x] **Step 3: Implement** — in compactContext replace the `orphans` field:

```ts
const dirOf = (file: string) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".");
const byDir = new Map<string, OrphanDTO[]>();
for (const o of [...orphans].sort((a, b) => a.file.localeCompare(b.file))) {
  const dir = dirOf(o.file);
  byDir.set(dir, [...(byDir.get(dir) ?? []), o]);
}
const orphanGroups = [...byDir.keys()].sort().map((dir) => ({
  dir,
  orphans: byDir.get(dir)!.map((o) => ({
    stableId: o.stableId, label: o.label, file: o.file,
    ...(o.residualKind !== undefined ? { residualKind: o.residualKind } : {}),
  })),
}));
```

Update the function's return type and JSDoc. Fix any existing test that asserts the old `orphans` field of compact output.

- [x] **Step 4: Run, verify pass**
- [x] **Step 5: Commit** `feat(srev): compact context groups orphans by directory`

---

### Task 5: Glob-based orphan-units at plan submit

Plans should say `"orphanFiles": ["docs/**", "README.md"]` instead of 32 exact stableIds. Resolution is server-side at submit so web, CLI and coverage share one truth (same principle as attachments).

**Files:**
- Create: `packages/server/src/globs.ts`
- Modify: `packages/server/src/validate.ts:17-53` (schema)
- Modify: `packages/server/src/routes/sessions.ts:186-245` (resolve before coverage)
- Modify: `packages/skill/src/api.ts:63-65` (UnitInput type)
- Test: `packages/server/test/globs.test.ts` (new), `packages/server/test/routes.test.ts`

**Interfaces:**
- Produces `globToRegExp(glob: string): RegExp` — supports `**` (any segments), `*` (within segment), `?` (single non-slash char); everything else literal. Anchored full-path match on repo-relative posix paths.
- Produces `resolveOrphanFiles(units, orphanNodes: { stableId: string; file: string }[]): { units: ResolvedUnit[]; emptyUnits: string[] }` — expands each orphan-unit's `orphanFiles` into `orphanStableIds` (explicit ids first, glob matches appended, deduped; ids already claimed by any explicit list or an earlier unit's globs are skipped — first unit wins). `emptyUnits` lists labels of units left with zero members.
- Schema: orphan units accept `orphanStableIds?` and/or `orphanFiles?` (at least one non-empty). Flow units unchanged.

- [x] **Step 1: Failing glob tests** (`packages/server/test/globs.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { globToRegExp, resolveOrphanFiles } from "../src/globs.js";

describe("globToRegExp", () => {
  it("** crosses directories", () => {
    expect(globToRegExp("docs/**").test("docs/a/b.md")).toBe(true);
    expect(globToRegExp("docs/**").test("src/a.md")).toBe(false);
  });
  it("* stays within a segment", () => {
    expect(globToRegExp("*.md").test("README.md")).toBe(true);
    expect(globToRegExp("*.md").test("docs/x.md")).toBe(false);
    expect(globToRegExp("packages/*/package.json").test("packages/web/package.json")).toBe(true);
    expect(globToRegExp("packages/*/package.json").test("packages/web/src/package.json")).toBe(false);
  });
  it("? matches one non-slash char; regex specials stay literal", () => {
    expect(globToRegExp("a?.ts").test("ab.ts")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });
});

describe("resolveOrphanFiles", () => {
  const orphans = [
    { stableId: "d1", file: "docs/a.md" }, { stableId: "d2", file: "docs/b.md" },
    { stableId: "c1", file: "package.json" },
  ];
  it("expands globs into orphanStableIds after explicit ids", () => {
    const { units } = resolveOrphanFiles(
      [{ kind: "orphans", label: "docs", orphanFiles: ["docs/**"] }], orphans);
    expect(units[0].orphanStableIds).toEqual(["d1", "d2"]);
  });
  it("first unit wins on overlapping globs; explicit claims beat globs", () => {
    const { units } = resolveOrphanFiles([
      { kind: "orphans", label: "one", orphanStableIds: ["d2"] },
      { kind: "orphans", label: "docs", orphanFiles: ["docs/**"] },
      { kind: "orphans", label: "all md again", orphanFiles: ["**"] },
    ], orphans);
    expect(units[1].orphanStableIds).toEqual(["d1"]);
    expect(units[2].orphanStableIds).toEqual(["c1"]);
  });
  it("reports units whose globs matched nothing", () => {
    const { emptyUnits } = resolveOrphanFiles(
      [{ kind: "orphans", label: "nope", orphanFiles: ["nothing/**"] }], orphans);
    expect(emptyUnits).toEqual(["nope"]);
  });
});
```

- [x] **Step 2: Run, verify fail** (module doesn't exist)
- [x] **Step 3: Implement `packages/server/src/globs.ts`**

```ts
// Orphan-unit file globs (plan submit): a plan can claim orphans by path
// pattern instead of hand-listing stableIds. Deliberately tiny — `**`, `*`,
// `?` over repo-relative posix paths — not a general glob engine.
import type { PlanUnitInput } from "./coverage.js";

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; }
      else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export interface ResolvedUnit extends PlanUnitInput { orphanStableIds?: string[] }

/**
 * Expand orphan-units' `orphanFiles` globs into stableIds against the
 * session's orphan set (changed nodes in no flow). Explicit ids anywhere are
 * claimed first; glob matches then fill units in plan order (first unit
 * wins), so overlapping globs never double-assign. Returns the labels of
 * units that ended up with zero members so the route can 400 loudly instead
 * of writing a hollow unit.
 */
export function resolveOrphanFiles(
  units: PlanUnitInput[],
  orphanNodes: { stableId: string; file: string }[]
): { units: ResolvedUnit[]; emptyUnits: string[] } {
  const claimed = new Set<string>(
    units.flatMap((u) => (u.kind === "orphans" ? u.orphanStableIds ?? [] : []))
  );
  const emptyUnits: string[] = [];
  const resolved = units.map((u) => {
    if (u.kind !== "orphans" || !u.orphanFiles?.length) return u;
    const regexps = u.orphanFiles.map(globToRegExp);
    const matched = orphanNodes
      .filter((o) => !claimed.has(o.stableId) && regexps.some((r) => r.test(o.file)))
      .map((o) => o.stableId);
    for (const id of matched) claimed.add(id);
    const orphanStableIds = [...(u.orphanStableIds ?? []), ...matched];
    if (orphanStableIds.length === 0) emptyUnits.push(u.label);
    return { ...u, orphanStableIds };
  });
  return { units: resolved, emptyUnits };
}
```

Add `orphanFiles?: string[]` to `PlanUnitInput` in `packages/server/src/coverage.ts`.

- [x] **Step 4: Schema + route failing tests** (`packages/server/test/routes.test.ts`, plan describe — the stub provider's node files come from `StubGraphProvider`; check its fixture files in `packages/server/src/graph/stub.ts` and target one that is an orphan, or drive a custom provider like neighboring tests do)

```ts
it("resolves orphanFiles globs into unit members at submit", async () => {
  // create session first (existing helper pattern in this file)
  const res = await app.request(`/api/sessions/${sessionId}/plan`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ units: [{ kind: "orphans", label: "everything", orphanFiles: ["**"] }] }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  const unit = body.units.find((u: { label: string }) => u.label === "everything");
  expect(unit.memberStableIds.length).toBeGreaterThan(0);
  expect(body.coverage.unassigned).toBe(0);
});
it("400s when a glob-only unit matches nothing", async () => {
  const res = await app.request(`/api/sessions/${sessionId}/plan`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ units: [{ kind: "orphans", label: "nope", orphanFiles: ["no/such/dir/**"] }] }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/nope/);
});
```

- [x] **Step 5: Implement schema + route**

`validate.ts` orphanUnitSchema:

```ts
const orphanUnitSchema = z.object({
  kind: z.literal("orphans"),
  label: z.string().trim(),
  rationale: z.string().optional(),
  orphanStableIds: z.array(z.string().min(1)).optional(),
  orphanFiles: z.array(z.string().min(1)).optional(),
});
```

superRefine emptiness check becomes: orphan unit needs `orphanStableIds` or `orphanFiles` non-empty (`(u.orphanStableIds?.length ?? 0) + (u.orphanFiles?.length ?? 0) > 0`); the duplicate-id scan keeps using explicit `orphanStableIds ?? []`.

`routes/sessions.ts` plan handler, after `getFlows` (line ~200), before `computeCoverage`:

```ts
const inAnyFlow = new Set(flows.flatMap((f) => f.steps.map((s) => s.stableId)));
const orphanNodes = sessionNodes.filter(
  (n) => n.changeStatus === "changed" && !inAnyFlow.has(n.stableId)
);
const { units: resolvedUnits, emptyUnits } = resolveOrphanFiles(body.units, orphanNodes);
if (emptyUnits.length > 0) {
  return c.json({ error: `orphanFiles matched no unassigned changes for unit(s): ${emptyUnits.join(", ")}` }, 400);
}
```

Then use `resolvedUnits` everywhere `body.units` was used below (computeCoverage, deriveAttachments, the forEach that createUnit's).

`packages/skill/src/api.ts` UnitInput orphans variant: `{ kind: "orphans"; orphanStableIds?: string[]; orphanFiles?: string[]; label: string; rationale?: string }`.

- [x] **Step 6: Run all server + skill tests, verify pass**
- [x] **Step 7: Commit** `feat(server): orphan-units by file glob — plans stop hand-listing stableIds`

---

### Task 6: Docs, version, bundle

**Files:**
- Modify: `packages/skill/skill.md`, `plugin/skills/structured-review/SKILL.md` (check whether build-plugin.mjs copies it — if generated, edit only the source)
- Modify: `README.md`, `AGENTS.md` (srev CLI blocks)
- Modify: `plugin/.claude-plugin/plugin.json` (0.4.0)
- Rebuild: `node scripts/build-plugin.mjs`

- [x] **Step 1: Doc updates** — in both skill docs and README/AGENTS:
  - `srev session create --branch <b> --base <ref|empty>` — note `empty` reviews the whole repo.
  - `srev context` output: `mergeSuggestions` (pre-computed merge guideline — trust it, spend judgment on labels/order), `orphanGroups` (directory-grouped), `commitSubjects` (replaces the git-log intent step — drop that step from the skill instructions).
  - Plan file: orphan-units accept `orphanFiles` globs (`**`, `*`, `?`); prefer globs over stableId lists; first unit wins on overlap; empty match = submit error.
- [x] **Step 2: Bump plugin version to 0.4.0; rebuild bundle; `git status` must show only intended files**
- [x] **Step 3: `pnpm typecheck && pnpm test` — all green**
- [x] **Step 4: Commit** `docs+build: DX wave 3 — skill/README catch-up, plugin 0.4.0, bundle rebuild`

## Self-Review Notes

- Spec coverage: suggestion #1 → Task 1, #2 → Task 3, #3 → Task 4, #4 → Task 5, #6 → Task 2, docs/packaging → Task 6. Suggestion #5 (unassigned loop) needed no change by design.
- Type consistency: `PlanUnitInput.orphanFiles` (coverage.ts) feeds validate.ts schema and globs.ts; skill `UnitInput` mirrors it. `suggestMerges` consumes exactly the compact-context flow shape.
- Ordering note: Task 4 changes compact output shape consumed in Task 3's cli change — implement `mergeSuggestions` against `compact.flows` which is unchanged by Task 4; safe in either order.
