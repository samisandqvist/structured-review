# Map review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a review session's change on the component map and let the reviewer reach and review every changed item from it.

**Architecture:** The session pins its base commit. On the first map request the hub makes a shared clone of the repository at that commit in a temporary directory, indexes it with a second graph provider, and runs the component-map evidence and check on the base. On submit it applies the stored model to the head index and stores a change overlay (changed components, new/removed/changed crossings, new surfaces, touched contracts, unmapped files, node ownership) with the map. The web map draws the overlay and lists a leaf's changed items, opening them in the existing review view.

**Tech Stack:** TypeScript, Hono, node:sqlite, SCIP, React, TanStack Query, Zustand, elkjs, vitest.

**Spec:** docs/superpowers/specs/2026-10-27-map-review-design.md

## Global Constraints

- No em dashes; no "X, not Y" phrasing; docs and code describe current state only.
- New files: 95% statements/lines/functions, 90% branches; changed lines 95%.
- Functions: complexity ≤15, nesting ≤4, ≤5 params, ≤80 lines.
- `pnpm verify` passes; plugin bundles regenerated with `pnpm build && pnpm build:plugin`.
- Nothing is written into the reviewed repository or its `.git`.
- structured-review is public: no private project names in code, tests or docs.

## Spike result (done before planning)

- A shared clone (`git clone --shared --no-checkout` + `checkout --detach <sha>`) indexes like the head and keeps every git-based code path working. It writes nothing into the source repository. It replaces `git archive` from the spec.
- TypeScript in-repo reference keys were identical with and without linked `node_modules` (851 keys). Python resolves packages from the same interpreter environment for base and head. The copy is indexed bare.
- The head index contained 64 gitignored build files (`packages/*/dist`) that a clean checkout lacks. Both indexes are limited to tracked files (Task 1).

## Review Focus

1. A session whose base is the empty tree (`--base empty`): no base checkout, plain map, no overlay.
2. A hub restart after the map was stored: the base checkout is gone; evidence/check must recreate it, GET map must not need it.
3. A base ref that moved after session creation: diffs, residuals and the base checkout all use the pinned commit.
4. A bind entry whose symbol was renamed at the head: contract touched (binding lost) plus a new surface for the renamed symbol's uses.
5. Sessions created before this change (empty `base_sha`): everything falls back to `baseRef`.

---

### Task 1: Tracked-only reference index

**Files:** Modify `packages/server/src/graph/scip.ts` (getReferenceIndex). Test `packages/server/test/references-scip.test.ts`.

- [ ] Test: write an untracked `src/api/scratch.ts` calling `getJob` into the fixture after the commit; expect `index.files` to omit it and no reference with `file === "src/api/scratch.ts"`. Run, see it fail.
- [ ] Implement: in `getReferenceIndex`, when `trackedFiles(this.repoRoot)` is non-null, pass only documents whose `file` is tracked to `buildReferenceIndex`.
- [ ] Run `pnpm --filter @srev/server test references-scip`; commit `fix(map): limit the reference index to tracked files`.

### Task 2: Pinned base commit

**Files:** Modify `packages/server/src/db/schema.ts` (v12: `ALTER TABLE review_sessions ADD COLUMN base_sha TEXT NOT NULL DEFAULT ''`), `repo/sessions.ts` (createSession takes `baseSha`; row maps `baseSha`), `types.ts` (`ReviewSession.baseSha: string`), `routes/sessions.ts` (resolve once, use the sha for subgraph, reconcile, residuals), `routes/nodes.ts`, `routes/changes.ts`, `routes/comments.ts`, `routes/shape.ts` (use `diffBase(session)`). Test `packages/server/test/base-pin.test.ts`.

**Interfaces:** Produces `diffBase(session: ReviewSession): string` in `repo/sessions.ts` returning `session.baseSha || session.baseRef`.

- [ ] Test: fixture repo on branch `feature` with base `main`; create a session; then add a commit to `main` that changes the same file (`git commit-tree` + `update-ref`); `GET /:id/nodes/:nodeId` diff and `GET /:id/changes` still show the original change; `session.baseSha` equals the old `main` sha. A second test: a session row with `base_sha = ''` uses `baseRef`. Run, see them fail.
- [ ] Implement as listed. `--base empty` stores the empty-tree sha as `baseSha`.
- [ ] Run server tests; commit `feat(review): pin the session's base commit`.

### Task 3: Base checkout and base index

**Files:** Create `packages/server/src/map/base.ts`. Modify `context.ts` (`providerFor?: (root: string) => GraphProvider; baseDir?: string`), `index.ts` (scip: `providerFor = (root) => new ScipGraphProvider({ repoRoot: root })`, `baseDir = SREV_BASE_DIR || join(tmpdir(), "srev-bases")`), `routes/sessions.ts` (DELETE drops the base). Test `packages/server/test/map-base.test.ts`.

**Interfaces:** Produces
- `isCommit(sha: string, root: string): boolean`
- `class BaseIndexes { constructor(baseDir: string, providerFor: (root: string) => GraphProvider); get(sessionId: string, repoRoot: string, sha: string): Promise<{ root: string; index: ReferenceIndex }>; drop(sessionId: string): void }`
  `get` reuses `<baseDir>/<sessionId>` when its HEAD is `sha`, otherwise recreates it with `git clone --shared --no-checkout -q` and `git checkout -q --detach sha`; memoizes the index promise per session and evicts it on failure.

- [ ] Tests: (a) `get` yields a checkout whose file content is the base version and whose `git rev-parse HEAD` is the sha; (b) `git -C repo worktree list` has one entry and the repo's `.git` gained no files; (c) a second `get` reuses the provider result (providerFor called once); (d) after deleting the directory, `get` on a fresh `BaseIndexes` recreates it; (e) `drop` removes the directory; (f) `isCommit` is false for the empty-tree sha. Use a stub provider whose `getReferenceIndex` returns a fixed index.
- [ ] Implement; wire `ctx.bases = new BaseIndexes(...)` lazily in the map route from `ctx.baseDir` and `ctx.providerFor`.
- [ ] Run tests; commit `feat(map): base checkout and index for review sessions`.

### Task 4: Change overlay

**Files:** Create `packages/server/src/map/change.ts`; add types to `map/types.ts`; Test `packages/server/test/map-change.test.ts`.

**Interfaces:** Produces
```ts
interface ChangeInput {
  model: MapModel; base: ResolvedMap; head: ReferenceIndex;
  nodes: { id: string; file: string; startLine: number; endLine: number; isTest: boolean; changed: boolean }[];
  files: { path: string; status: string; oldPath?: string }[];
  changedLines: (file: string) => LineRange[];
}
interface MapChange {
  baseSha: string;
  components: { id: string; items: number }[];          // own items, ancestors included in their count
  nodeComponents: Record<string, string | null>;        // non-test changed node id -> leaf owner (null = unclaimed)
  crossings: { interface: string; requirer: string; status: "new" | "removed" | "changed"; added: CallSite[]; removed: CallSite[] }[];
  surfaces: { provider: string; requirers: string[]; symbol: string; file: string; line: number; sites: CallSite[] }[];
  touched: { interface: string; reasons: ("body" | "binding-lost" | "evidence")[]; symbols: string[] }[];
  unmapped: { component: string | null; files: string[] }[];
}
function compareVersions(input: ChangeInput, baseSha: string): MapChange
```
Rules (from the spec, plus rulings):
- Head sites come from `resolveBindings` + `resolveReferences` of the model over `head`; binding and coverage issues are not errors here.
- Crossing key: `(interface, requirer)`; site key `file|caller|symbol` compared as sets. New = head only; removed = base only; changed = both with different key sets.
- New surface: each head `uncovered` entry.
- Touched: a head binding whose line lies in a changed non-test node span or in `changedLines(file)` (body); a base binding symbol missing among head bindings (binding-lost); an evidence file in `files` (evidence).
- Components: owners of changed non-test nodes and of deleted files; counts roll up to ancestors. Unmapped: changed files owned by no component or by a component with parts, grouped by that component.

- [ ] Tests with hand-built indexes: new crossing; removed crossing; changed crossing (added caller); moved-within-file call is unchanged; renamed bound symbol gives binding-lost and a surface; body change touches; evidence file change touches; changed node counted on leaf and ancestors; new top-level file unmapped under root; deleted file marks its owner.
- [ ] Implement; keep each function under the limits.
- [ ] Run; commit `feat(map): compare base and head on the component map`.

### Task 5: Map routes in review sessions

**Files:** Modify `routes/map.ts`; `repo/maps.ts` (overlay stored inside `resolved` as `map.change`); `map/types.ts` (`ResolvedMap.change?: MapChange`). Test `packages/server/test/map-routes.test.ts` (extend).

- [ ] Tests: in a session with a commit base, evidence lists base files (a file deleted at the head is present, a new head file absent); submit stores `map.change` with a new crossing introduced by the head; GET map returns `baseSha` and `change`; an empty-base session behaves as before (no `change`).
- [ ] Implement `mapSource(session)` returning base `{ root, index }` when `ctx.providerFor` is set and `isCommit(diffBase(session))`, else the head. Evidence, check and submit use `source.root` for `sourceReader`, `findMarkerRoots`, `loadComponentMap` and `fileExists`. Submit builds the overlay from session nodes, `changedFileStatuses(diffBase)`, and `fileChangedRanges`.
- [ ] Run; commit `feat(map): build review maps on the base and mark the change`.

### Task 6: Web overlay and leaf review list

**Files:** Modify `packages/web/src/map/types.ts`, `levels.ts`, `MapDiagram.tsx`, `MapPanel.tsx`, `MapPage.tsx`, `styles.css`. Tests `packages/web/test/map-levels.test.ts`, `MapPage.test.tsx`, fixture `map-fixture.ts`.

**Interfaces:** `levels.ts` adds `changeMarks(map, level)` returning per-component item counts, per-connector status (`new|removed|changed`), touched interface ids and level surfaces; connectors for new crossings are added at their level.

- [ ] Tests: a changed leaf shows its count; a new crossing yields a connector with status `new`; a removed one keeps its connector with status `removed`; a touched interface is flagged; the panel of a changed leaf lists its changed items with review state in walk order (tests placed by attachment parent) and clicking one sets the current node and navigates to the review; without `change` nothing changes.
- [ ] Implement. Markers: new = accent stroke with a "new" tag; removed = dashed muted stroke with "removed"; touched = ring on the lollipop; counts as "6 changed · 2 reviewed" in the box. Both themes.
- [ ] Run web tests; commit `feat(map): show the change on the map and review from it`.

### Task 7: Skill, CLI and docs

**Files:** `packages/skill/component-map.md`, `packages/skill/skill.md`, `packages/skill/src/map.ts` (prettyReport adds the change summary when present; evidence pretty shows `base <sha>`), `docs/component-map.md`, `docs/architecture.md`, `docs/review-model.md` (one paragraph), spec status line, regenerated plugin bundles. Test `packages/skill/test/map.test.ts`.

- [ ] Test the pretty change summary; implement; update docs; `pnpm build && pnpm build:plugin`; `pnpm verify`; commit `feat(map): review sessions in the skills and docs`.

### Task 8: End-to-end check and final review

- [ ] In a fresh clone, create a review session against a commit before the component map merge, build a map through the CLI, and confirm on the page that the map module, its routes and web view appear as changed with the expected new crossings.
- [ ] Whole-branch review by a fresh reviewer; one fix pass.
