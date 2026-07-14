# Viability P0 Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one review trustworthy end to end, fixing the release-blocking defects from `docs/software-viability-usability-implementation-findings.md` (2026-07-12).

**Architecture:** All fixes stay inside the existing package layout: `@crw/server` (Hono + better-sqlite3 + SCIP provider), `@crw/web` (Vite/React), `@crw/skill` (orchestration CLI). No new runtime dependencies — Node builtins (`crypto`, `fs`, `path`) only. Server remains the single git/graph/state authority.

**Tech Stack:** TypeScript strict ESM (imports use `.js` suffixes), pnpm workspaces, vitest, Hono, better-sqlite3.

## Global Constraints

- No new npm dependencies in any package (Node builtins are fine).
- TypeScript strict mode; ESM imports must use `.js` suffix for local files.
- All existing tests keep passing: run `pnpm test` at repo root (baseline: 17 files / 105 tests green) and `pnpm typecheck`.
- Follow existing code style: compact, minimal comments that state constraints only, `randomId()` for IDs, repo functions in `packages/server/src/repo/`, routes in `packages/server/src/routes/`.
- Server must bind to `127.0.0.1` by default (Task 7).
- Comment export format is a flat ordered array under key `comments` (Task 1).
- Never invent git behavior: every git call goes through helpers in `packages/server/src/diff.ts`.
- Commit after each task with a conventional-commit message.

---

### Task 1: Fix multi-comment export data loss

The current `exportComments` returns `Record<nodeId, ExportedComment>`, so a second comment on the same node overwrites the first at export. Change the export contract to a flat, creation-ordered array.

**Files:**
- Modify: `packages/server/src/repo/comments.ts:34-51` (`exportComments`)
- Modify: `packages/server/src/types.ts:63-72` (`ExportedComment` gains `id`)
- Modify: `packages/server/src/routes/comments.ts:20-22` (wrap in `{ comments: [...] }`)
- Modify: `packages/skill/src/orchestrate.ts:52-54` (return type)
- Modify: `packages/web/src/api/client.ts:108-109` (return type)
- Test: `packages/server/test/repo.test.ts` and/or `packages/server/test/routes.test.ts` (wherever export is currently tested — extend there)

**Interfaces:**
- Produces: `exportComments(db, sessionId): ExportedComment[]` — ordered by `created_at` ascending; `ExportedComment` gains `id: string`. Route `GET /api/sessions/:id/export` returns `{ comments: ExportedComment[] }`.

- [ ] **Step 1: Write the failing test** — in the existing export test location add:

```ts
it("preserves multiple comments on one node in creation order", () => {
  // use existing helpers to create a session + node, then:
  createComment(db, session.id, node.id, "snippetA", "first", "ctxA");
  createComment(db, session.id, node.id, "snippetB", "second", "ctxB");
  const exported = exportComments(db, session.id);
  expect(exported).toHaveLength(2);
  expect(exported.map((c) => c.text)).toEqual(["first", "second"]);
  expect(exported[0].nodeId).toBe(node.id);
  expect(exported[0].stableId).toBe(node.stableId);
});
```

Also add a route-level test asserting `GET /api/sessions/:id/export` responds `{ comments: [...] }` with both comments.

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @crw/server test` → new tests FAIL (length 1 / wrong shape).

- [ ] **Step 3: Implement** — in `repo/comments.ts` replace the record-building loop:

```ts
export function exportComments(db: DB, sessionId: string): ExportedComment[] {
  const rows = db.prepare(
    `SELECT c.id, c.node_id, n.stable_id, n.label, n.file, c.hunk_snippet, c.text, c.structural_context, c.created_at
     FROM comments c JOIN nodes n ON c.node_id = n.id WHERE c.session_id = ? ORDER BY c.created_at`
  ).all(sessionId) as { /* row shape incl. id */ }[];
  return rows.map((row) => ({
    id: row.id, nodeId: row.node_id, stableId: row.stable_id, label: row.label, file: row.file,
    hunkSnippet: row.hunk_snippet, text: row.text,
    structuralContext: row.structural_context, createdAt: row.created_at,
  }));
}
```

Add `id: string` to `ExportedComment` in `types.ts`. Route becomes `c.json({ comments: exportComments(...) })`. Update the skill/web client return types to `{ comments: unknown[] }`-shaped generics (`Promise<{ comments: Record<string, unknown>[] }>` is fine).

- [ ] **Step 4: Run tests + typecheck** — `pnpm --filter @crw/server test && pnpm typecheck` → PASS. Fix any existing tests that asserted the old record shape (they now assert array shape — order preserved).

- [ ] **Step 5: Commit** — `git commit -m "fix(server): export all comments per node as ordered array"`

---

### Task 2: Fail visibly on incomplete git data at session creation

`changedFiles` returns `[]` and `gitHeadSha` returns `null` on git failure, so a broken repo silently yields an "empty but complete-looking" session. Session creation must fail loudly when base-ref resolution or changed-file enumeration fails; per-node diff fallbacks stay as-is.

**Files:**
- Modify: `packages/server/src/diff.ts` (add `GitError`, `resolveRef`, `changedFilesStrict`; quiet stderr on all execFileSync calls)
- Modify: `packages/server/src/residuals.ts:25` (use `changedFilesStrict`)
- Modify: `packages/server/src/routes/sessions.ts:60-102` (validate before creating the session row)
- Test: `packages/server/test/diff.test.ts`, `packages/server/test/routes.test.ts`

**Interfaces:**
- Produces: `class GitError extends Error { phase: "resolve-ref" | "list-files" | "read-diff"; }`; `resolveRef(ref: string, root?: string): string | null`; `changedFilesStrict(baseRef: string, root?: string): string[]` (throws `GitError` on git failure; `[]` genuinely means no changes). Existing `changedFiles` stays for callers that want soft behavior.
- Produces (route): `POST /api/sessions` returns 400 `{ error: string, phase: string }` when the repo/baseRef is unusable. Task 3 builds on this validation block.

- [ ] **Step 1: Write failing tests**

```ts
// diff.test.ts
it("resolveRef resolves HEAD and returns null for unknown refs", () => {
  expect(resolveRef("HEAD", fixtureRepo)).toMatch(/^[0-9a-f]{40}$/);
  expect(resolveRef("no-such-ref", fixtureRepo)).toBeNull();
});
it("changedFilesStrict throws GitError outside a repo", () => {
  expect(() => changedFilesStrict("HEAD", emptyTmpDir)).toThrow(GitError);
});
it("changedFilesStrict returns [] for a clean repo", () => {
  expect(changedFilesStrict("HEAD", fixtureRepo)).toEqual([]);
});
// routes.test.ts — app wired with repoRoot pointing at a non-git tmp dir:
it("POST /api/sessions fails with 400 when the repo is unusable", async () => {
  const res = await app.request("/api/sessions", { method: "POST", body: JSON.stringify({ branch: "HEAD", baseRef: "main" }) });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toMatch(/git|ref/i);
});
it("POST /api/sessions fails with 400 for an unresolvable baseRef", async () => { /* real fixture repo, baseRef: "does-not-exist" */ });
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** In `diff.ts`:

```ts
export class GitError extends Error {
  constructor(readonly phase: "resolve-ref" | "list-files" | "read-diff", message: string) {
    super(message);
    this.name = "GitError";
  }
}

const QUIET = { stdio: ["ignore", "pipe", "pipe"] as const };

export function resolveRef(ref: string, root: string = repoRoot()): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: root, encoding: "utf8", ...QUIET }).trim();
  } catch {
    return null;
  }
}

export function changedFilesStrict(baseRef: string, root: string = repoRoot()): string[] {
  try {
    const raw = execFileSync("git", ["diff", "--name-only", baseRef], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...QUIET });
    return raw.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    throw new GitError("list-files", `git diff --name-only ${baseRef} failed: ${(e as Error).message}`);
  }
}
```

Add `...QUIET` to every other `execFileSync` call in `diff.ts` (their catch-fallbacks are intentional; the quieting stops expected-failure stderr flooding test output). In `residuals.ts` switch to `changedFilesStrict` (session creation is the only caller path). In `routes/sessions.ts` POST handler, **before** `createSession`:

```ts
const headSha = gitHeadSha(ctx.repoRoot);
if (!headSha) return c.json({ error: "not a git repository (or git unavailable)", phase: "resolve-ref" }, 400);
if (!resolveRef(body.baseRef, ctx.repoRoot)) {
  return c.json({ error: `cannot resolve base ref '${body.baseRef}'`, phase: "resolve-ref" }, 400);
}
```

and wrap the subgraph/residuals block in `try/catch (e)` → `if (e instanceof GitError) return c.json({ error: e.message, phase: e.phase }, 400); throw e;`. Pass the already-resolved `headSha` to `createSession` (no more `?? ""`).

- [ ] **Step 4: Run** `pnpm --filter @crw/server test && pnpm typecheck` → PASS, and confirm expected-failure tests no longer print git stderr noise.

- [ ] **Step 5: Commit** — `git commit -m "fix(server): fail session creation loudly on git errors"`

---

### Task 3: Enforce the current-working-tree branch contract

`branch` is session metadata only; SCIP indexes the working tree. Enforce the short-term contract: the requested branch must be `HEAD` or the currently checked-out branch, else 400.

**Files:**
- Modify: `packages/server/src/diff.ts` (add `currentBranch`)
- Modify: `packages/server/src/routes/sessions.ts` (validation in POST, after Task 2's block)
- Test: `packages/server/test/diff.test.ts`, `packages/server/test/routes.test.ts`

**Interfaces:**
- Consumes: Task 2's validation block position in POST handler.
- Produces: `currentBranch(root?: string): string | null` — `git rev-parse --abbrev-ref HEAD` (returns `"HEAD"` when detached, `null` on git failure). POST rejects mismatches with 400 `{ error, phase: "resolve-ref" }`.

- [ ] **Step 1: Failing tests**

```ts
// diff.test.ts
it("currentBranch returns the checked-out branch", () => {
  expect(currentBranch(fixtureRepo)).toBe("main"); // fixture created with git init -b main
});
// routes.test.ts (fixture repo checked out on main)
it("POST /api/sessions accepts branch HEAD and the checked-out branch", async () => { /* 200 for both */ });
it("POST /api/sessions rejects a branch that is not checked out", async () => {
  // { branch: "some-other-branch", baseRef: "HEAD" } -> 400, error mentions both names
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**

```ts
// diff.ts
export function currentBranch(root: string = repoRoot()): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8", ...QUIET }).trim();
  } catch {
    return null;
  }
}
```

In POST handler after Task 2's checks:

```ts
const checkedOut = currentBranch(ctx.repoRoot);
if (body.branch !== "HEAD" && body.branch !== checkedOut) {
  return c.json({
    error: `session branch '${body.branch}' is not checked out (current: '${checkedOut ?? "unknown"}'); ` +
      `this tool reviews the current working tree — check the branch out or pass HEAD`,
    phase: "resolve-ref",
  }, 400);
}
```

- [ ] **Step 4: Run tests + typecheck → PASS.** Ensure existing route tests still pass — they create sessions with `branch: "HEAD"` or the fixture's actual branch; update any that used an arbitrary name.

- [ ] **Step 5: Commit** — `git commit -m "feat(server): enforce current-working-tree branch contract"`

---

### Task 4: Schema versioning and migrations

`CREATE TABLE IF NOT EXISTS` never alters existing tables, so an old `review.db` breaks silently after upgrades. Add `PRAGMA user_version`-based ordered migrations. Task 5 adds the first real migration (a new column).

**Files:**
- Modify: `packages/server/src/db/schema.ts` (export `SCHEMA_VERSION` and `MIGRATIONS`)
- Modify: `packages/server/src/db/connection.ts` (run migrations in both factories)
- Test: `packages/server/test/schema.test.ts`

**Interfaces:**
- Produces: `SCHEMA_VERSION: number` (starts at 1), `MIGRATIONS: Record<number, string>` (SQL applied when upgrading TO that version; version 1 is the baseline `SCHEMA_SQL`), and `migrate(db: DB): void` in `connection.ts` applied by `createDatabase`/`createMemoryDatabase`. A DB **newer** than the app throws with a clear message.

- [ ] **Step 1: Failing tests**

```ts
// schema.test.ts
it("stamps a fresh database with SCHEMA_VERSION", () => {
  const db = createMemoryDatabase();
  expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
});
it("migrates a version-0 database with existing tables to current", () => {
  // simulate an old DB: create with raw SCHEMA_SQL minus future columns, user_version 0
  // then run migrate(db) and expect user_version === SCHEMA_VERSION and no throw
});
it("rejects a database newer than the application", () => {
  const db = new Database(":memory:");
  db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
  expect(() => migrate(db)).toThrow(/newer/i);
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**

```ts
// schema.ts (append)
export const SCHEMA_VERSION = 1;
/** SQL applied when upgrading TO each version. Version 1 = baseline tables. */
export const MIGRATIONS: Record<number, string> = {
  1: SCHEMA_SQL,
};
```

```ts
// connection.ts
import { SCHEMA_VERSION, MIGRATIONS } from "./schema.js";

export function migrate(db: DB): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `review database schema v${current} is newer than this application (v${SCHEMA_VERSION}); ` +
      `upgrade the app or delete/archive the database file`
    );
  }
  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v}`);
    })();
  }
}
```

Both factories call `migrate(db)` instead of `db.exec(SCHEMA_SQL)`. Note the baseline uses `IF NOT EXISTS`, so pre-versioning DBs (user_version 0 with tables already present) upgrade cleanly through v1.

- [ ] **Step 4: Run tests + typecheck → PASS.**

- [ ] **Step 5: Commit** — `git commit -m "feat(server): versioned schema migrations via PRAGMA user_version"`

---

### Task 5: Content-sensitive repo fingerprint for SCIP cache and stale detection

The SCIP cache key uses `git status --porcelain`, which misses edits to an already-dirty file; stale detection compares only HEAD SHAs. Introduce one content-sensitive fingerprint used by both.

**Files:**
- Modify: `packages/server/src/diff.ts` (add `repoFingerprint`)
- Modify: `packages/server/src/graph/scip.ts:183-192` (`repoStateKey` uses it)
- Modify: `packages/server/src/db/schema.ts` + `connection.ts` migration v2 (add `repo_fingerprint TEXT NOT NULL DEFAULT ''` to `review_sessions`; bump `SCHEMA_VERSION` to 2; add the column to baseline `SCHEMA_SQL` too so fresh DBs match)
- Modify: `packages/server/src/repo/sessions.ts` (store/read `repoFingerprint`)
- Modify: `packages/server/src/types.ts` (`ReviewSession.repoFingerprint: string`)
- Modify: `packages/server/src/routes/sessions.ts` (store at creation; GET compares and returns `stale` + `staleReason`)
- Test: `packages/server/test/diff.test.ts`, `packages/server/test/scip-cache.test.ts`, `packages/server/test/routes.test.ts`, `packages/server/test/schema.test.ts` (v1→v2 migration)

**Interfaces:**
- Consumes: Task 4's `MIGRATIONS`/`SCHEMA_VERSION`.
- Produces: `repoFingerprint(root?: string): string | null` — sha256 hex over: HEAD sha + `git diff HEAD` (covers staged + unstaged tracked changes) + each untracked file's path and content hash (`git ls-files --others --exclude-standard`); `null` when git fails. GET `/api/sessions/:id` returns `{ stale: boolean, staleReason?: "head-moved" | "working-tree-changed" }` (omitted, as now, when git/recorded state is unavailable). Web already reads `stale`; `staleReason` is additive.

- [ ] **Step 1: Failing tests**

```ts
// diff.test.ts — fixture repo helper already exists in this file's style
it("repoFingerprint changes when an already-dirty file is edited again", () => {
  writeFileSync(join(dir, "a.txt"), "dirty1\n");
  const f1 = repoFingerprint(dir);
  writeFileSync(join(dir, "a.txt"), "dirty2\n"); // porcelain status unchanged: still " M a.txt"
  const f2 = repoFingerprint(dir);
  expect(f2).not.toBe(f1);
});
it("repoFingerprint changes when an untracked file's content changes", () => { /* same pattern with a new file */ });
it("repoFingerprint is stable when nothing changed", () => { /* two calls equal */ });
// scip-cache.test.ts — extend the real-repo describe:
it("re-indexes after editing an already-dirty file (content-sensitive key)", () => {
  writeFileSync(join(dir, "a.txt"), "dirty1\n");
  const k1 = p.publicKey();
  writeFileSync(join(dir, "a.txt"), "dirty2\n");
  expect(p.publicKey()).not.toBe(k1);
});
// routes.test.ts
it("GET session reports stale with reason working-tree-changed after an edit", async () => { /* create session, edit tracked file, GET -> stale true, staleReason "working-tree-changed" */ });
it("GET session reports head-moved after a commit", async () => { /* create session, commit, GET -> staleReason "head-moved" */ });
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**

```ts
// diff.ts
import { createHash } from "node:crypto";

/** Content-sensitive repo state fingerprint, or null when git is unavailable. */
export function repoFingerprint(root: string = repoRoot()): string | null {
  try {
    const h = createHash("sha256");
    h.update(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", ...QUIET }));
    h.update(execFileSync("git", ["diff", "HEAD"], { cwd: root, maxBuffer: 256 * 1024 * 1024, ...QUIET }));
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", ...QUIET })
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

`scip.ts` `repoStateKey`: `return repoFingerprint(this.repoRoot) ?? \`no-git:${Math.random()}\`;` (keep the method `protected` so the cache tests' overrides still work). Migration v2 in `schema.ts`:

```ts
export const SCHEMA_VERSION = 2;
export const MIGRATIONS: Record<number, string> = {
  1: SCHEMA_SQL, // baseline (already includes repo_fingerprint for fresh DBs)
  2: `ALTER TABLE review_sessions ADD COLUMN repo_fingerprint TEXT NOT NULL DEFAULT '';`,
};
```

Guard: migration 2 must be a no-op error-free on fresh DBs — since baseline SCHEMA_SQL (v1) now includes the column, wrap: fresh DBs go 0→1→2, so v2's ALTER would fail with "duplicate column". Fix by keeping the column OUT of `SCHEMA_SQL` and letting v2 add it — baseline stays v1 shape, fresh DBs run both migrations. (Do it this way; it is the invariant that keeps migrations testable.)

Sessions repo: `createSession(db, branch, baseRef, headSha, repoFingerprint)` inserts the column; `getSession` maps it. GET route:

```ts
const currentHead = gitHeadSha(ctx.repoRoot);
const currentFp = repoFingerprint(ctx.repoRoot);
let stale: boolean | undefined;
let staleReason: "head-moved" | "working-tree-changed" | undefined;
if (currentHead && session.headSha) {
  if (currentHead !== session.headSha) { stale = true; staleReason = "head-moved"; }
  else if (currentFp && session.repoFingerprint && currentFp !== session.repoFingerprint) {
    stale = true; staleReason = "working-tree-changed";
  } else stale = false;
}
return c.json({ session, units, coverage, ...(stale === undefined ? {} : { stale }), ...(staleReason ? { staleReason } : {}) });
```

POST stores `repoFingerprint(ctx.repoRoot) ?? ""`.

- [ ] **Step 4: Run full suite + typecheck → PASS** (includes updated schema migration test v0→v2).

- [ ] **Step 5: Commit** — `git commit -m "fix(server): content-sensitive repo fingerprint for scip cache and stale detection"`

---

### Task 6: Never let "Mark reviewed" hide comments

A node with comments can be set to `reviewed-clean`, hiding that it was commented. Normalize on the server: setting `reviewed-clean` on a node that has comments stores `reviewed-commented`.

**Files:**
- Modify: `packages/server/src/repo/comments.ts` (add `nodeHasComments`)
- Modify: `packages/server/src/routes/nodes.ts:35-44` (normalize in PATCH)
- Test: `packages/server/test/routes.test.ts`

**Interfaces:**
- Produces: `nodeHasComments(db: DB, nodeId: string): boolean`.

- [ ] **Step 1: Failing test**

```ts
it("normalizes reviewed-clean to reviewed-commented when the node has comments", async () => {
  // create session + node, POST a comment on it, then:
  const res = await app.request(`/api/sessions/${sid}/nodes/${nid}`, {
    method: "PATCH", body: JSON.stringify({ reviewStatus: "reviewed-clean" }),
  });
  const { node } = await res.json();
  expect(node.reviewStatus).toBe("reviewed-commented");
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**

```ts
// repo/comments.ts
export function nodeHasComments(db: DB, nodeId: string): boolean {
  const row = db.prepare("SELECT 1 FROM comments WHERE node_id = ? LIMIT 1").get(nodeId);
  return row !== undefined;
}
```

```ts
// routes/nodes.ts PATCH, before updateNodeReviewStatus:
const status = body.reviewStatus === "reviewed-clean" && nodeHasComments(ctx.db, nodeId)
  ? "reviewed-commented"
  : body.reviewStatus;
updateNodeReviewStatus(ctx.db, nodeId, status, body.reviewedInUnit);
```

- [ ] **Step 4: Run tests + typecheck → PASS.**

- [ ] **Step 5: Commit** — `git commit -m "fix(server): commented nodes cannot be marked reviewed-clean"`

---

### Task 7: Production launch path — serve the web build, bind loopback, add start scripts

The skill opens `http://localhost:3456?session=...` but the server mounts only API routes; `static.ts` is dead code; nothing binds explicitly to loopback. Make the compiled server serve the built SPA.

**Files:**
- Rewrite: `packages/server/src/static.ts` (self-contained static + SPA-fallback router; drop the unused `serveStatic` import)
- Modify: `packages/server/src/app.ts` (optional `webDistPath` in `AppContext`; mount static/fallback AFTER API routes)
- Modify: `packages/server/src/index.ts` (default dist path, loopback binding, `CRW_HOST` override warning)
- Modify: `packages/server/package.json` (`"start": "node dist/index.js"`)
- Modify: root `package.json` (`"start": "pnpm --filter @crw/server start"`)
- Test: `packages/server/test/static.test.ts` (new)

**Interfaces:**
- Produces: `createStaticRoute(webDistPath: string): Hono` serving files from the dist dir with correct content types, path-traversal protection, and `index.html` fallback for GET paths that are not `/api/*` and match no file. `AppContext.webDistPath?: string` — when set and `index.html` exists, `createApp` mounts it after the API routes.

- [ ] **Step 1: Failing tests** — build a temp fake dist in the test:

```ts
// static.test.ts
const dist = mkdtempSync(join(tmpdir(), "crw-dist-"));
mkdirSync(join(dist, "assets"), { recursive: true });
writeFileSync(join(dist, "index.html"), "<!doctype html><div id=root></div>");
writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
const app = createApp({ db: createMemoryDatabase(), graphProvider: new StubGraphProvider(), repoRoot: someFixture, webDistPath: dist });

it("serves index.html at /", async () => {
  const res = await app.request("/");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(await res.text()).toContain("id=root");
});
it("serves static assets with correct content type", async () => {
  const res = await app.request("/assets/app.js");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("javascript");
});
it("falls back to index.html for SPA routes (e.g. /?session=x deep links)", async () => {
  const res = await app.request("/some/client/route");
  expect(await res.text()).toContain("id=root");
});
it("does not shadow API routes", async () => {
  const res = await app.request("/health");
  expect((await res.json()).ok).toBe(true);
});
it("rejects path traversal", async () => {
  const res = await app.request("/..%2f..%2fetc%2fpasswd");
  expect(res.status).not.toBe(200); // must not leak files outside dist (404 or fallback html are both fine — assert body is not file content)
});
it("app without webDistPath keeps current behavior", async () => { /* / -> 404 */ });
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**

```ts
// static.ts — no external deps; ~40 lines
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { Hono } from "hono";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".map": "application/json", ".woff2": "font/woff2",
};

/** Serves a built SPA: real files from dist, index.html for everything else. */
export function createStaticRoute(webDistPath: string) {
  const router = new Hono();
  const indexHtml = () => readFileSync(join(webDistPath, "index.html"), "utf8");
  router.get("/*", (c) => {
    const rel = normalize(decodeURIComponent(new URL(c.req.url).pathname)).replace(/^([/\\]|\.\.)+/, "");
    const file = join(webDistPath, rel);
    if (rel && file.startsWith(webDistPath) && existsSync(file) && statSync(file).isFile()) {
      return c.body(readFileSync(file), 200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    }
    return c.html(indexHtml());
  });
  return router;
}
```

`app.ts`: add `webDistPath?: string` to `AppContext`; after the API mounts:

```ts
if (resolved.webDistPath && existsSync(join(resolved.webDistPath, "index.html"))) {
  app.route("/", createStaticRoute(resolved.webDistPath));
}
```

(Hono matches `/api/*` and `/health` first because they're registered first.) `index.ts`:

```ts
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// dist/index.js -> ../../web/dist ; src/index.ts (dev) resolves the same way
const webDistPath = process.env.CRW_WEB_DIST ?? join(here, "..", "..", "web", "dist");

const hostname = process.env.CRW_HOST || "127.0.0.1";
if (hostname !== "127.0.0.1" && hostname !== "localhost") {
  console.warn(`WARNING: binding to ${hostname} — the review API is unauthenticated; keep it loopback-only unless you know why`);
}
const app = createApp({ db, graphProvider, webDistPath: existsSync(join(webDistPath, "index.html")) ? webDistPath : undefined });
serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`review hub on http://localhost:${info.port} (graph provider: ${which}${existsSync(join(webDistPath, "index.html")) ? "" : "; web UI not built — run pnpm build"})`);
});
```

Add the `start` scripts to both package.json files.

- [ ] **Step 4: Run tests + typecheck → PASS.** Then a real smoke check: `pnpm build && (pnpm start &) && sleep 2 && curl -sf http://127.0.0.1:3456/ | grep -q '<div id="root">' && curl -sf http://127.0.0.1:3456/health && kill %1` — record actual output.

- [ ] **Step 5: Commit** — `git commit -m "feat(server): serve built web UI, bind loopback, add start scripts"`

---

### Task 8: Fixture-repository end-to-end test

Prove the whole chain on a real TypeScript fixture repo with the real SCIP provider: session → flows → plan → review → two comments on one node → export.

**Files:**
- Create: `packages/server/test/e2e.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7 (array export, branch contract, git validation, fingerprint staleness).

- [ ] **Step 1: Write the test** (it should pass immediately if Tasks 1–7 are correct — the failing-first step here is conceptual: it fails on any regression):

```ts
// e2e.test.ts — one describe, generous timeout (scip-typescript indexes the fixture)
// Fixture: tmp git repo (git init -b main), files:
//   src/helper.ts   export function helper(x: number) { return x + 1; }
//   src/handler.ts  import { helper } from "./helper.js"; export function handler() { return helper(1); }
//   src/handler.test.ts  import { handler } from "./handler.js"; ... (simple assertion, named *.test.ts)
// commit; then CHANGE helper.ts (return x + 2) and handler.ts (call helper twice), add config.json (untracked->added+committed? keep it simple: modify tracked files only), do NOT commit.
// App: createApp({ db: createMemoryDatabase(), graphProvider: new ScipGraphProvider({ repoRoot: dir }), repoRoot: dir })
it("runs a full review through comment export", { timeout: 120_000 }, async () => {
  // 1. POST /api/sessions { branch: "HEAD", baseRef: "HEAD" } -> 200; nodes include helper + handler
  // 2. GET  /flows -> at least one flow (handler -> helper) OR orphans contain both (assert coverage, not exact shape)
  // 3. PUT  /plan with one unit covering everything -> coverage.unassigned === 0
  // 4. GET  /nodes; pick the helper node
  // 5. POST two comments on the helper node ("first", "second")
  // 6. PATCH helper node reviewStatus reviewed-clean -> comes back reviewed-commented (Task 6)
  // 7. GET /export -> comments.length === 2, order ["first","second"], each has stableId + file
  // 8. edit helper.ts again; GET /api/sessions/:id -> stale true, staleReason "working-tree-changed" (Task 5)
});
it("rejects a session for a non-checked-out branch", async () => { /* branch: "release" -> 400 (Task 3) */ });
```

Write the real code for every numbered step — the comments above are the spec, the test body must be executable assertions. Use `baseRef: "HEAD"` so the diff is the uncommitted working-tree change.

- [ ] **Step 2: Run** — `pnpm --filter @crw/server test e2e` → PASS. If scip-typescript needs a `package.json` in the fixture for module resolution, add a minimal `{ "name": "fixture", "type": "module" }` plus `tsconfig.json` (`{"compilerOptions": {"module": "esnext", "moduleResolution": "bundler"}, "include": ["src"]}`) to the fixture.

- [ ] **Step 3: Run the full suite** — `pnpm test && pnpm typecheck` → all green.

- [ ] **Step 4: Commit** — `git commit -m "test(server): fixture-repo end-to-end review through comment export"`

---

### Task 9: Root README

There is no user-facing README; AGENTS.md is contributor guidance. Write one honest quick start.

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: exact commands and env vars from Task 7 (`pnpm build`, `pnpm start`, `CRW_HOST`, `CRW_WEB_DIST`, `CRW_DB_PATH`, `PORT`, `GRAPH_PROVIDER`), export shape from Task 1, branch contract from Task 3.

- [ ] **Step 1: Write README.md** covering, in this order:
  1. One-paragraph pitch: TypeScript-first, coverage-guaranteed review walkthrough that orders every changed hunk by execution flow. Status: alpha.
  2. **Quick start (production):** `pnpm install` → `pnpm build` → `pnpm start` → open `http://localhost:3456` (the CLI below opens it with a session).
  3. **Create a review session:** `node packages/skill/dist/orchestrate.js --base main` (reviews the *current working tree* against `--base`; the branch named in the session must be checked out — that is the contract, state it plainly). Development mode: `pnpm dev` (Vite on 5173 proxying `/api`).
  4. **Scope and contract:** TypeScript only today (scip-typescript); reviews current working tree vs `baseRef`; staged+unstaged included; stale warning appears if HEAD moves or the tree changes after session creation.
  5. **Providers and env vars:** table of `GRAPH_PROVIDER` (scip default / crg / stub), `CRW_DB_PATH` (default `review.db`), `PORT` (3456), `CRW_HOST` (127.0.0.1; warning if changed), `CRW_WEB_DIST`, `CRW_SERVER_URL`, `SCIP_CONTEXT_DEPTH`, `SCIP_NO_CACHE`.
  6. **Comment export:** `GET /api/sessions/:id/export` → `{ comments: [...] }` ordered array, one entry per comment (multiple per node preserved).
  7. **Data & privacy:** everything local; server binds loopback; DB is a local SQLite file.
  8. **Troubleshooting:** stale session chip (recreate session), "not a git repository"/"cannot resolve base ref" 400s, "database schema newer than application", web UI not built hint.
  9. Link to `docs/` design documents and `AGENTS.md` for contributors.
  Use exact commands verified in Task 7's smoke check. Do not document features that don't exist.

- [ ] **Step 2: Verify commands** — run the quick-start commands as written (build/start/curl) and fix any drift.

- [ ] **Step 3: Commit** — `git commit -m "docs: add user-facing README with quick start and contracts"`
