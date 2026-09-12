# Line-Specific Commenting Implementation Plan

> Project, branch, and application identifiers in this historical note have been anonymized.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Comments can be anchored to a range of changed diff lines inside a node — selected in the diff pane, validated server-side against the node's current diff, stored, and carried through export in a GitHub-mappable shape — while node-level comments keep working unchanged.

**Architecture:** GitHub-shaped anchor `{startLine, startSide, endLine, endSide}` (side = `"old"`|`"new"`), stored as one JSON TEXT column on `comments` (migration v4). The server validates anchors by resolving both endpoints to row indexes in the node's rendered diff (`anchorRowRange` in diff.ts — endpoints must be changed lines, rendered order start ≤ end) and scopes the stored snippet to the anchored rows. The web side lifts an ephemeral (non-persisted) line selection into the zustand UI store, shared by `DiffView` (click/shift-click selection, highlight) and `CommentBox` (chip, anchor on mutation, anchored-comment display).

**Tech Stack:** TypeScript strict ESM (`.js` import suffixes), Hono, zod v4, better-sqlite3 (versioned migrations), React + zustand + react-query, vitest + @testing-library/react.

**Source spec:** `docs/superpowers/specs/2026-07-16-line-comments-design.md` (approved 2026-07-16).

## Global Constraints

- pnpm, never npm. Server tests: `pnpm vitest run packages/server/test/<file>.ts`; web tests: `pnpm vitest run packages/web/test/<file>.tsx`. Typecheck: `pnpm -r typecheck`.
- ESM: relative imports carry the `.js` suffix even in `.ts`/`.tsx` files.
- Anchor is **all-or-nothing optional**: absent = node-level comment, byte-for-byte today's behavior (existing CommentBox test asserts the mutation payload has no extra keys — build payloads conditionally).
- Anchorable lines: **changed lines only** (`added` on side `"new"` via `newLine`; `removed` on side `"old"` via `oldLine`). Context lines are never endpoints; a range's interior may span context rows.
- Range order is **row position in the rendered diff** (`NodeDiff.lines`), so mixed-side ranges (start on a removed line, end on an added one) are legal.
- Validation failure → `400` with a specific message; no clamping, no silent node-level fallback.
- Schema change goes through the versioned migration system (`SCHEMA_VERSION` 3 → 4 in `packages/server/src/db/schema.ts`); baseline `SCHEMA_SQL` stays untouched (see the v2 comment there for why).
- Line selection state is **not persisted** (excluded from the zustand `partialize`).
- No new dependencies.
- Commit after every task; messages end with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and the Claude-Session line used on this branch.

---

### Task 1: Anchor type, migration v4, repo persistence

**Files:**
- Modify: `packages/server/src/types.ts` (after the `Comment` interface, ~line 60)
- Modify: `packages/server/src/db/schema.ts:61-72`
- Modify: `packages/server/src/repo/comments.ts`
- Modify: `packages/server/src/routes/comments.ts:28` (call-site arity only — full route behavior is Task 2)
- Test: `packages/server/test/schema.test.ts`, `packages/server/test/repo.test.ts` (append)

**Interfaces:**
- Produces:
  - `type AnchorSide = "old" | "new"`, `interface CommentAnchor { startLine: number; startSide: AnchorSide; endLine: number; endSide: AnchorSide }` (types.ts)
  - `Comment` and `ExportedComment` gain `anchor: CommentAnchor | null`
  - `createComment(db, sessionId, nodeId, hunkSnippet, text, structuralContext, anchor?: CommentAnchor | null): Comment` (trailing optional param, default `null`)
  - Migration: `SCHEMA_VERSION = 4`, `MIGRATIONS[4] = ALTER TABLE comments ADD COLUMN anchor TEXT;`

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/test/schema.test.ts` (it already imports `createMemoryDatabase` / migration pieces — match its existing imports):

```ts
describe("v4 anchor column", () => {
  it("migrates to v4 and persists an anchor JSON round-trip", () => {
    const db = createMemoryDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(4);
    const cols = (db.prepare("PRAGMA table_info(comments)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("anchor");
    db.close();
  });
});
```

Append to `packages/server/test/repo.test.ts` inside (or alongside) its existing comments describe — follow the file's existing fixture pattern for creating a session + node, then:

```ts
  it("persists and parses a comment anchor; null anchor round-trips", () => {
    // reuse the file's existing helpers to create a session and a node
    const anchored = createComment(db, session.id, node.id, "snip", "left on lines", "", {
      startLine: 3, startSide: "old", endLine: 5, endSide: "new",
    });
    const plain = createComment(db, session.id, node.id, "snip", "node-level", "");
    const byId = new Map(getCommentsBySession(db, session.id).map((c) => [c.id, c]));
    expect(byId.get(anchored.id)?.anchor).toEqual({ startLine: 3, startSide: "old", endLine: 5, endSide: "new" });
    expect(byId.get(plain.id)?.anchor).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/server/test/schema.test.ts packages/server/test/repo.test.ts`
Expected: FAIL — user_version is 3 / no `anchor` column / `createComment` arity + `anchor` property missing (TS compile errors count as the RED).

- [ ] **Step 3: Implement**

3a. `packages/server/src/types.ts`, after the `Comment` interface's closing brace region — add the types and extend both interfaces:

```ts
export type AnchorSide = "old" | "new";
/** GitHub-shaped line anchor: endpoints are CHANGED diff lines; removed lines
 *  anchor by old-file line on side "old", added lines by new-file line on
 *  side "new". Range order is row position in the rendered node diff. */
export interface CommentAnchor {
  startLine: number;
  startSide: AnchorSide;
  endLine: number;
  endSide: AnchorSide;
}
```

Add to `Comment`: `anchor: CommentAnchor | null;`
Add to `ExportedComment`: `anchor: CommentAnchor | null;`

3b. `packages/server/src/db/schema.ts`:

```ts
export const SCHEMA_VERSION = 4;
```

and add to `MIGRATIONS`:

```ts
  4: `ALTER TABLE comments ADD COLUMN anchor TEXT;`,
```

3c. `packages/server/src/repo/comments.ts`:

- `CommentRow` gains `anchor: string | null;`
- `rowToComment` gains `anchor: row.anchor ? (JSON.parse(row.anchor) as CommentAnchor) : null,`
- `createComment` signature and INSERT:

```ts
export function createComment(
  db: DB, sessionId: string, nodeId: string, hunkSnippet: string,
  text: string, structuralContext: string, anchor: CommentAnchor | null = null
): Comment {
  const id = randomId("cmt");
  const createdAt = Date.now();
  db.prepare(
    "INSERT INTO comments (id, session_id, node_id, hunk_snippet, text, structural_context, created_at, anchor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, sessionId, nodeId, hunkSnippet, text, structuralContext, createdAt, anchor ? JSON.stringify(anchor) : null);
  return { id, sessionId, nodeId, hunkSnippet, text, structuralContext, createdAt, anchor };
}
```

- `exportComments`: add `c.anchor` to the SELECT column list and to the row mapping: `anchor: r.anchor ? (JSON.parse(r.anchor) as CommentAnchor) : null,` (match the function's existing row-mapping style; import `CommentAnchor` from `../types.js`).

3d. `packages/server/src/routes/comments.ts:28` — the existing `createComment(ctx.db, sessionId, body.nodeId, formatHunkSnippet(diff.lines), body.text, "")` call is already compatible (trailing param defaults to `null`); no change needed in this task. Verify it compiles.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/server/test/schema.test.ts packages/server/test/repo.test.ts`
Expected: PASS (including all pre-existing tests — the migration runs 1→4 on fresh DBs).

- [ ] **Step 5: Full server suite, typecheck, commit**

Run: `pnpm vitest run packages/server/test/` and `pnpm -r typecheck` — all green.

```bash
git add packages/server/src/types.ts packages/server/src/db/schema.ts packages/server/src/repo/comments.ts packages/server/test/schema.test.ts packages/server/test/repo.test.ts
git commit -m "feat(server): comment anchor type, v4 migration, repo persistence"
```

---

### Task 2: Anchor validation + anchored comment route + export

**Files:**
- Modify: `packages/server/src/diff.ts` (add `anchorRowRange` near `extractHunkDiff`)
- Modify: `packages/server/src/validate.ts:73-76`
- Modify: `packages/server/src/routes/comments.ts` (POST handler)
- Modify: `packages/skill/skill.md:4` (description says "node-anchored comments" → "node- and line-anchored comments")
- Test: `packages/server/test/diff.test.ts`, `packages/server/test/routes.test.ts` (append)

**Interfaces:**
- Consumes: `CommentAnchor`, `AnchorSide` (Task 1); existing `DiffLine`, `getNodeDiff`, `getNodeDiffForRanges`, `formatHunkSnippet`.
- Produces: `anchorRowRange(lines: DiffLine[], anchor: CommentAnchor): { startIdx: number; endIdx: number } | null` (diff.ts); `commentCreateSchema` accepts optional `anchor`; POST `/api/sessions/:id/comments` validates anchors and stores range-scoped snippets.

- [ ] **Step 1: Write the failing unit tests for `anchorRowRange`**

Append to `packages/server/test/diff.test.ts` (import `anchorRowRange` from `../src/diff.js` and `type CommentAnchor` from `../src/types.js`):

```ts
describe("anchorRowRange", () => {
  const lines: DiffLine[] = [
    { type: "context", oldLine: 10, newLine: 10, text: "ctx" },     // idx 0
    { type: "removed", oldLine: 11, newLine: null, text: "gone" },  // idx 1
    { type: "added", oldLine: null, newLine: 11, text: "new1" },    // idx 2
    { type: "context", oldLine: 12, newLine: 12, text: "ctx" },     // idx 3
    { type: "added", oldLine: null, newLine: 13, text: "new2" },    // idx 4
  ];
  const a = (startLine: number, startSide: "old" | "new", endLine: number, endSide: "old" | "new"): CommentAnchor =>
    ({ startLine, startSide, endLine, endSide });

  it("resolves a single added line", () => {
    expect(anchorRowRange(lines, a(11, "new", 11, "new"))).toEqual({ startIdx: 2, endIdx: 2 });
  });
  it("resolves a mixed-side range (removed -> added) spanning context", () => {
    expect(anchorRowRange(lines, a(11, "old", 13, "new"))).toEqual({ startIdx: 1, endIdx: 4 });
  });
  it("rejects a context line as endpoint", () => {
    expect(anchorRowRange(lines, a(12, "new", 13, "new"))).toBeNull();
  });
  it("rejects a line not in the diff", () => {
    expect(anchorRowRange(lines, a(99, "new", 99, "new"))).toBeNull();
  });
  it("rejects an inverted range (rendered order)", () => {
    expect(anchorRowRange(lines, a(13, "new", 11, "old"))).toBeNull();
  });
  it("rejects a wrong-side endpoint (added line addressed as old)", () => {
    expect(anchorRowRange(lines, a(11, "old", 11, "new"))).toEqual({ startIdx: 1, endIdx: 2 });
    expect(anchorRowRange(lines, a(13, "old", 13, "old"))).toBeNull();
  });
});
```

(`DiffLine` is already imported by this test file; add it if not.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/server/test/diff.test.ts`
Expected: FAIL — `anchorRowRange` not exported.

- [ ] **Step 3: Implement `anchorRowRange`**

In `packages/server/src/diff.ts` (near `extractHunkDiff`; import `AnchorSide`, `CommentAnchor` from `./types.js` and re-export them if convenient):

```ts
/**
 * Resolve a comment anchor's endpoints to row indexes in a node's rendered
 * diff. Endpoints must be CHANGED lines — `added` addressed by newLine on
 * side "new", `removed` by oldLine on side "old" — and the range must be
 * ordered by row position. Null = anchor does not resolve (context line,
 * absent line, wrong side, or inverted range).
 */
export function anchorRowRange(
  lines: DiffLine[],
  anchor: CommentAnchor
): { startIdx: number; endIdx: number } | null {
  const find = (line: number, side: AnchorSide) =>
    lines.findIndex((l) =>
      side === "new" ? l.type === "added" && l.newLine === line : l.type === "removed" && l.oldLine === line
    );
  const startIdx = find(anchor.startLine, anchor.startSide);
  const endIdx = find(anchor.endLine, anchor.endSide);
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) return null;
  return { startIdx, endIdx };
}
```

Run: `pnpm vitest run packages/server/test/diff.test.ts` — PASS.

- [ ] **Step 4: Write the failing route tests**

Append to `packages/server/test/routes.test.ts`. The file's `StubGraphProvider` sessions need a real diff to anchor into; follow the file's existing pattern for creating a session against `fixtureRoot`, then commit a change so the node has added lines. Concretely (adapt fixture naming to the file's conventions):

```ts
describe("anchored comments", () => {
  /** Create a session whose stub node has a real diff: write a file, commit as
   *  base, append lines, so `git diff main` yields added lines inside the
   *  node's span. Assumes StubGraphProvider's node file/span — align the file
   *  path and span with what the stub returns (see graph/stub.ts). */
  async function makeSessionWithDiff() {
    const g = (...a: string[]) => execFileSync("git", a, { cwd: fixtureRoot, encoding: "utf8" });
    // stub node points at a file+span; write base content, commit, then modify
    writeFileSync(join(fixtureRoot, STUB_FILE), BASE_CONTENT);
    g("add", "."); g("commit", "-m", "base");
    writeFileSync(join(fixtureRoot, STUB_FILE), MODIFIED_CONTENT); // adds a line inside the node span
    const res = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session, subgraph } = await res.json();
    const nodesRes = await app.request(`/api/sessions/${session.id}/nodes`);
    const { nodes } = await nodesRes.json();
    return { session, node: nodes.find((n: { changeStatus: string }) => n.changeStatus === "changed") };
  }

  it("creates an anchored comment with a range-scoped snippet and exports the anchor", async () => {
    const { session, node } = await makeSessionWithDiff();
    // find an added line to anchor on via the node diff endpoint
    const diffRes = await app.request(`/api/sessions/${session.id}/nodes/${node.id}`);
    const { diff } = await diffRes.json();
    const added = diff.lines.find((l: { type: string }) => l.type === "added");
    expect(added).toBeDefined();
    const anchor = { startLine: added.newLine, startSide: "new", endLine: added.newLine, endSide: "new" };
    const res = await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: node.id, text: "anchored!", anchor }),
    });
    expect(res.status).toBe(200);
    const { comment } = await res.json();
    expect(comment.anchor).toEqual(anchor);
    expect(comment.hunkSnippet).toContain(added.text);
    expect(comment.hunkSnippet.split("\n")).toHaveLength(1); // range-scoped: just the anchored row

    const exportRes = await app.request(`/api/sessions/${session.id}/export`);
    const exported = await exportRes.json();
    expect(exported.comments.find((c: { id: string }) => c.id === comment.id).anchor).toEqual(anchor);
  });

  it("rejects an anchor that does not resolve (context line / absent line)", async () => {
    const { session, node } = await makeSessionWithDiff();
    const res = await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: node.id, text: "bad", anchor: { startLine: 99999, startSide: "new", endLine: 99999, endSide: "new" } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/anchor/i);
  });

  it("rejects a half-specified anchor at the schema layer", async () => {
    const { session, node } = await makeSessionWithDiff();
    const res = await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: node.id, text: "bad", anchor: { startLine: 1, startSide: "new" } }),
    });
    expect(res.status).toBe(400);
  });

  it("node-level comments still work with a whole-node snippet", async () => {
    const { session, node } = await makeSessionWithDiff();
    const res = await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: node.id, text: "node-level" }),
    });
    expect(res.status).toBe(200);
    const { comment } = await res.json();
    expect(comment.anchor).toBeNull();
  });
});
```

Before finalizing this step, read `packages/server/src/graph/stub.ts` and the existing routes tests that create real diffs (the residual tests do) and align `STUB_FILE`/`BASE_CONTENT`/`MODIFIED_CONTENT` with the stub node's `file`, `startLine`, `endLine` so the added line genuinely falls inside the node span. If the stub's span makes this awkward, follow whatever fixture pattern the existing residual-range route tests use — they already build sessions with real git diffs.

- [ ] **Step 5: Run to verify failure**

Run: `pnpm vitest run packages/server/test/routes.test.ts`
Expected: new tests FAIL — schema strips `anchor` (unknown key), so `comment.anchor` comes back null / 400s don't fire.

- [ ] **Step 6: Implement schema + route**

6a. `packages/server/src/validate.ts` — replace `commentCreateSchema`:

```ts
const anchorSide = z.enum(["old", "new"]);
export const commentAnchorSchema = z.object({
  startLine: z.number().int().positive(),
  startSide: anchorSide,
  endLine: z.number().int().positive(),
  endSide: anchorSide,
});

export const commentCreateSchema = z.object({
  nodeId: z.string().min(1, "nodeId is required"),
  text: z.string().trim().min(1, "comment text must be nonempty").max(10_000, "comment too long"),
  anchor: commentAnchorSchema.optional(),
});
```

6b. `packages/server/src/routes/comments.ts` — POST handler body (imports: add `getNodeDiffForRanges`, `anchorRowRange` from `../diff.js`, `type CommentAnchor` from `../types.js`):

```ts
    // Same residual-aware diff derivation the diff pane uses (routes/nodes.ts) —
    // the anchor must validate against exactly what the reviewer sees.
    const diff =
      (node.residualRanges && node.residualRanges.length > 0
        ? getNodeDiffForRanges(session.baseRef, node.file, node.residualRanges, ctx.repoRoot)
        : null) ?? getNodeDiff(session.baseRef, node.file, node.startLine, node.endLine, node.changeStatus, ctx.repoRoot);

    let snippetLines = diff.lines;
    let anchor: CommentAnchor | null = null;
    if (body.anchor) {
      const range = anchorRowRange(diff.lines, body.anchor);
      if (!range) {
        return c.json({ error: "anchor does not resolve to changed lines in this node's current diff" }, 400);
      }
      anchor = body.anchor;
      snippetLines = diff.lines.slice(range.startIdx, range.endIdx + 1);
    }
    const comment = createComment(ctx.db, sessionId, body.nodeId, formatHunkSnippet(snippetLines), body.text, "", anchor);
    return c.json({ comment });
```

6c. `packages/skill/skill.md` line 4: change "exports node-anchored comments" to "exports node- and line-anchored comments".

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run packages/server/test/routes.test.ts packages/server/test/diff.test.ts`
Expected: PASS (all, including pre-existing comment tests — node-level path unchanged).

- [ ] **Step 8: Full server suite, typecheck, commit**

Run: `pnpm vitest run packages/server/test/` and `pnpm -r typecheck` — green.

```bash
git add packages/server/src/diff.ts packages/server/src/validate.ts packages/server/src/routes/comments.ts packages/skill/skill.md packages/server/test/diff.test.ts packages/server/test/routes.test.ts
git commit -m "feat(server): validate + store line-anchored comments with range-scoped snippets"
```

---

### Task 3: Web plumbing — client types, mutation, store selection state

**Files:**
- Modify: `packages/web/src/api/client.ts` (Comment interface ~line 22, createComment ~line 113)
- Modify: `packages/web/src/api/hooks.ts:60-67`
- Modify: `packages/web/src/store/ui.ts`
- Test: `packages/web/test/store-selection.test.ts` (new)

**Interfaces:**
- Consumes: server API shape from Tasks 1–2.
- Produces (webside — later tasks rely on these exact names):
  - `client.ts`: `export type AnchorSide = "old" | "new"`, `export interface CommentAnchor { startLine: number; startSide: AnchorSide; endLine: number; endSide: AnchorSide }`; `Comment.anchor: CommentAnchor | null`; `createComment(id, nodeId, text, anchor?: CommentAnchor)`
  - `hooks.ts`: `useCreateComment` mutationFn arg becomes `{ nodeId: string; text: string; anchor?: CommentAnchor }`
  - `store/ui.ts`: `export interface LineSelection { startIdx: number; endIdx: number; anchor: CommentAnchor; label: string }`; state `lineSelection: LineSelection | null`, `pendingAnchorHighlight: CommentAnchor | null`; actions `setLineSelection(sel: LineSelection | null)`, `requestAnchorHighlight(anchor: CommentAnchor)`, `clearAnchorHighlight()`; `setCurrentNode` clears both; **neither field is persisted** (not added to `partialize`).

- [ ] **Step 1: Write the failing store test**

Create `packages/web/test/store-selection.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useUIStore } from "../src/store/ui.js";
import type { CommentAnchor } from "../src/api/client.js";

const anchor: CommentAnchor = { startLine: 3, startSide: "new", endLine: 5, endSide: "new" };
const selection = { startIdx: 1, endIdx: 3, anchor, label: "lines +3…+5" };

beforeEach(() => {
  useUIStore.setState({ lineSelection: null, pendingAnchorHighlight: null, currentNodeId: null });
});

describe("line selection state", () => {
  it("sets and clears a line selection", () => {
    useUIStore.getState().setLineSelection(selection);
    expect(useUIStore.getState().lineSelection).toEqual(selection);
    useUIStore.getState().setLineSelection(null);
    expect(useUIStore.getState().lineSelection).toBeNull();
  });

  it("changing the current node clears selection and pending highlight", () => {
    useUIStore.getState().setLineSelection(selection);
    useUIStore.getState().requestAnchorHighlight(anchor);
    useUIStore.getState().setCurrentNode("other-node");
    expect(useUIStore.getState().lineSelection).toBeNull();
    expect(useUIStore.getState().pendingAnchorHighlight).toBeNull();
  });

  it("anchor highlight request round-trip", () => {
    useUIStore.getState().requestAnchorHighlight(anchor);
    expect(useUIStore.getState().pendingAnchorHighlight).toEqual(anchor);
    useUIStore.getState().clearAnchorHighlight();
    expect(useUIStore.getState().pendingAnchorHighlight).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/web/test/store-selection.test.ts`
Expected: FAIL — properties/actions don't exist (TS errors).

- [ ] **Step 3: Implement**

3a. `packages/web/src/api/client.ts`:

```ts
export type AnchorSide = "old" | "new";
export interface CommentAnchor {
  startLine: number;
  startSide: AnchorSide;
  endLine: number;
  endSide: AnchorSide;
}
```

`Comment` gains `anchor: CommentAnchor | null;`. `createComment` becomes:

```ts
  createComment: (id: string, nodeId: string, text: string, anchor?: CommentAnchor) =>
    fetchJson<{ comment: Comment }>(`/sessions/${id}/comments`, {
      method: "POST", body: JSON.stringify(anchor ? { nodeId, text, anchor } : { nodeId, text }),
    }),
```

3b. `packages/web/src/api/hooks.ts`:

```ts
export function useCreateComment(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, text, anchor }: { nodeId: string; text: string; anchor?: CommentAnchor }) =>
      api.createComment(sessionId, nodeId, text, anchor),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["comments", sessionId] });
    },
  });
}
```

(import `type CommentAnchor` from `./client.js`.)

3c. `packages/web/src/store/ui.ts` — add to `UIState` and the store (imports: `type CommentAnchor` from `../api/client.js`):

```ts
export interface LineSelection {
  startIdx: number;
  endIdx: number;
  anchor: CommentAnchor;
  label: string;
}
```

State fields + actions inside `create(...)`:

```ts
      lineSelection: null as LineSelection | null,
      pendingAnchorHighlight: null as CommentAnchor | null,
      setLineSelection: (sel) => set({ lineSelection: sel }),
      requestAnchorHighlight: (anchor) => set({ pendingAnchorHighlight: anchor }),
      clearAnchorHighlight: () => set({ pendingAnchorHighlight: null }),
```

and change `setCurrentNode` to clear both:

```ts
      setCurrentNode: (nodeId) => set({ currentNodeId: nodeId, lineSelection: null, pendingAnchorHighlight: null }),
```

Do NOT add either field to `partialize` — selection is ephemeral by spec.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/web/test/store-selection.test.ts packages/web/test/CommentBox.test.tsx`
Expected: PASS — including the existing "submits only nodeId and text" test (anchorless payload shape unchanged).

- [ ] **Step 5: Typecheck, commit**

Run: `pnpm -r typecheck` — green.

```bash
git add packages/web/src/api/client.ts packages/web/src/api/hooks.ts packages/web/src/store/ui.ts packages/web/test/store-selection.test.ts
git commit -m "feat(web): comment anchor types, mutation plumbing, ephemeral line-selection state"
```

---

### Task 4: DiffView — line selection UI + highlight + anchor-highlight resolution

**Files:**
- Modify: `packages/web/src/components/DiffView.tsx`
- Test: `packages/web/test/DiffView.test.tsx` (append)

**Interfaces:**
- Consumes: `useUIStore` (`lineSelection`, `setLineSelection`, `pendingAnchorHighlight`, `clearAnchorHighlight`), `LineSelection` (Task 3); `DiffLine`.
- Produces: exported pure helpers used by tests and CommentBox labeling:
  - `anchorFor(lines: DiffLine[], startIdx: number, endIdx: number): CommentAnchor | null` — null unless BOTH endpoint rows are changed lines
  - `selectionLabel(anchor: CommentAnchor): string` — `"line +13"` / `"lines -11…+13"` (`+` = new side, `-` = old side; `…` between endpoints)
  - `resolveAnchorRows(lines: DiffLine[], anchor: CommentAnchor): { startIdx: number; endIdx: number } | null` (client twin of the server's `anchorRowRange`, same semantics)

- [ ] **Step 1: Write the failing tests**

Append to `packages/web/test/DiffView.test.tsx` (align imports/render helpers with the file's existing conventions — it already renders `DiffView` with fixture lines):

```ts
import { anchorFor, selectionLabel, resolveAnchorRows } from "../src/components/DiffView.js";
import { useUIStore } from "../src/store/ui.js";

const LINES: DiffLine[] = [
  { type: "context", oldLine: 10, newLine: 10, text: "ctx" },
  { type: "removed", oldLine: 11, newLine: null, text: "gone" },
  { type: "added", oldLine: null, newLine: 11, text: "fresh" },
  { type: "added", oldLine: null, newLine: 12, text: "more" },
];

describe("anchor helpers", () => {
  it("derives a mixed-side anchor from row indexes", () => {
    expect(anchorFor(LINES, 1, 3)).toEqual({ startLine: 11, startSide: "old", endLine: 12, endSide: "new" });
  });
  it("refuses context endpoints", () => {
    expect(anchorFor(LINES, 0, 2)).toBeNull();
  });
  it("labels single and range selections", () => {
    expect(selectionLabel({ startLine: 12, startSide: "new", endLine: 12, endSide: "new" })).toBe("line +12");
    expect(selectionLabel({ startLine: 11, startSide: "old", endLine: 12, endSide: "new" })).toBe("lines -11…+12");
  });
  it("resolves an anchor back to row indexes", () => {
    expect(resolveAnchorRows(LINES, { startLine: 11, startSide: "old", endLine: 12, endSide: "new" })).toEqual({ startIdx: 1, endIdx: 3 });
    expect(resolveAnchorRows(LINES, { startLine: 99, startSide: "new", endLine: 99, endSide: "new" })).toBeNull();
  });
});

describe("line selection interaction", () => {
  beforeEach(() => useUIStore.setState({ lineSelection: null, pendingAnchorHighlight: null }));

  it("click on a changed line selects it; shift-click extends; context click is inert", () => {
    render(<DiffView node={NODE} diff={{ oldText: "", newText: "", lines: LINES }} />);
    const rows = screen.getAllByRole("row");
    fireEvent.click(rows[2]); // added newLine 11
    expect(useUIStore.getState().lineSelection?.anchor).toEqual({ startLine: 11, startSide: "new", endLine: 11, endSide: "new" });
    fireEvent.click(rows[3], { shiftKey: true }); // extend to newLine 12
    expect(useUIStore.getState().lineSelection?.anchor).toEqual({ startLine: 11, startSide: "new", endLine: 12, endSide: "new" });
    fireEvent.click(rows[0]); // context: inert
    expect(useUIStore.getState().lineSelection?.anchor).toEqual({ startLine: 11, startSide: "new", endLine: 12, endSide: "new" });
  });

  it("clicking the single selected line clears the selection", () => {
    render(<DiffView node={NODE} diff={{ oldText: "", newText: "", lines: LINES }} />);
    const rows = screen.getAllByRole("row");
    fireEvent.click(rows[2]);
    fireEvent.click(rows[2]);
    expect(useUIStore.getState().lineSelection).toBeNull();
  });

  it("selected rows carry a data-selected attribute", () => {
    render(<DiffView node={NODE} diff={{ oldText: "", newText: "", lines: LINES }} />);
    const rows = screen.getAllByRole("row");
    fireEvent.click(rows[1]);
    fireEvent.click(rows[3], { shiftKey: true });
    expect(rows[1]).toHaveAttribute("data-selected", "true");
    expect(rows[2]).toHaveAttribute("data-selected", "true");
    expect(rows[3]).toHaveAttribute("data-selected", "true");
    expect(rows[0]).not.toHaveAttribute("data-selected", "true");
  });

  it("resolves a pending anchor highlight into a selection and clears the request", () => {
    useUIStore.setState({ pendingAnchorHighlight: { startLine: 11, startSide: "new", endLine: 12, endSide: "new" } });
    render(<DiffView node={NODE} diff={{ oldText: "", newText: "", lines: LINES }} />);
    expect(useUIStore.getState().lineSelection?.startIdx).toBe(2);
    expect(useUIStore.getState().lineSelection?.endIdx).toBe(3);
    expect(useUIStore.getState().pendingAnchorHighlight).toBeNull();
  });
});
```

Use the test file's existing `NODE` fixture (or add one matching its `Node` shape). Note `getAllByRole("row")` indexes exclude gap rows for this fixture (no gaps: consecutive lines).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/web/test/DiffView.test.tsx`
Expected: FAIL — helpers not exported, rows not interactive.

- [ ] **Step 3: Implement**

In `packages/web/src/components/DiffView.tsx`:

3a. Pure helpers (module scope, exported; import `type CommentAnchor, type AnchorSide` from `../api/client.js`):

```ts
/** Side+line of a changed row; null for context rows. */
function endpointOf(l: DiffLine): { line: number; side: AnchorSide } | null {
  if (l.type === "added" && l.newLine !== null) return { line: l.newLine, side: "new" };
  if (l.type === "removed" && l.oldLine !== null) return { line: l.oldLine, side: "old" };
  return null;
}

export function anchorFor(lines: DiffLine[], startIdx: number, endIdx: number): CommentAnchor | null {
  const s = lines[startIdx] && endpointOf(lines[startIdx]);
  const e = lines[endIdx] && endpointOf(lines[endIdx]);
  if (!s || !e) return null;
  return { startLine: s.line, startSide: s.side, endLine: e.line, endSide: e.side };
}

export function selectionLabel(anchor: CommentAnchor): string {
  const fmt = (line: number, side: AnchorSide) => `${side === "old" ? "-" : "+"}${line}`;
  const start = fmt(anchor.startLine, anchor.startSide);
  const end = fmt(anchor.endLine, anchor.endSide);
  return start === end && anchor.startSide === anchor.endSide ? `line ${start}` : `lines ${start}…${end}`;
}

/** Client twin of the server's anchorRowRange — same resolution semantics. */
export function resolveAnchorRows(
  lines: DiffLine[],
  anchor: CommentAnchor
): { startIdx: number; endIdx: number } | null {
  const find = (line: number, side: AnchorSide) =>
    lines.findIndex((l) =>
      side === "new" ? l.type === "added" && l.newLine === line : l.type === "removed" && l.oldLine === line
    );
  const startIdx = find(anchor.startLine, anchor.startSide);
  const endIdx = find(anchor.endLine, anchor.endSide);
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) return null;
  return { startIdx, endIdx };
}
```

3b. `withSeparators` must carry the original row index so selection indexes refer to `lines`, not the rendered array:

```ts
function withSeparators(lines: DiffLine[]): ({ line: DiffLine; idx: number } | "gap")[] {
  const out: ({ line: DiffLine; idx: number } | "gap")[] = [];
  let lastOld: number | null = null;
  let lastNew: number | null = null;
  lines.forEach((l, idx) => {
    const oldGap = l.oldLine !== null && lastOld !== null && l.oldLine > lastOld + 1;
    const newGap = l.newLine !== null && lastNew !== null && l.newLine > lastNew + 1;
    if (out.length > 0 && (oldGap || newGap)) out.push("gap");
    out.push({ line: l, idx });
    if (l.oldLine !== null) lastOld = l.oldLine;
    if (l.newLine !== null) lastNew = l.newLine;
  });
  return out;
}
```

3c. `DiffLines` becomes selection-aware (reads the store directly):

```tsx
function DiffLines({ lines }: { lines: DiffLine[] }) {
  const lineSelection = useUIStore((s) => s.lineSelection);
  const setLineSelection = useUIStore((s) => s.setLineSelection);

  const handleClick = (idx: number, shiftKey: boolean) => {
    if (!endpointOf(lines[idx])) return; // context rows are inert
    if (lineSelection && shiftKey) {
      const startIdx = Math.min(lineSelection.startIdx, idx);
      const endIdx = Math.max(lineSelection.endIdx, idx);
      const anchor = anchorFor(lines, startIdx, endIdx);
      if (anchor) setLineSelection({ startIdx, endIdx, anchor, label: selectionLabel(anchor) });
      return;
    }
    if (lineSelection && lineSelection.startIdx === idx && lineSelection.endIdx === idx) {
      setLineSelection(null); // toggle off
      return;
    }
    const anchor = anchorFor(lines, idx, idx);
    if (anchor) setLineSelection({ startIdx: idx, endIdx: idx, anchor, label: selectionLabel(anchor) });
  };

  const isSelected = (idx: number) =>
    !!lineSelection && idx >= lineSelection.startIdx && idx <= lineSelection.endIdx;

  return (
    <div style={{ border: "1px solid #283143", borderRadius: 8, overflow: "hidden", background: "#11151f" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--mono)", fontSize: 17, lineHeight: 1.5 }}>
        <tbody>
          {withSeparators(lines).map((entry, i) =>
            entry === "gap" ? (
              <tr key={`gap-${i}`} data-testid="diff-gap">
                <td colSpan={4} style={{ padding: "2px 10px", color: "#5c6678", background: "#161c28", fontSize: 14, textAlign: "center" }}>⋯</td>
              </tr>
            ) : (
              <tr
                key={entry.idx}
                data-line-type={entry.line.type}
                data-selected={isSelected(entry.idx) ? "true" : undefined}
                onClick={(e) => handleClick(entry.idx, e.shiftKey)}
                style={{
                  background: isSelected(entry.idx) ? "rgba(96, 165, 250, 0.16)" : ROW_BG[entry.line.type],
                  boxShadow: isSelected(entry.idx) ? "inset 2px 0 0 #60a5fa" : undefined,
                  cursor: entry.line.type !== "context" ? "pointer" : undefined,
                }}
              >
                <td style={gutterStyle}>{entry.line.oldLine ?? ""}</td>
                <td style={gutterStyle}>{entry.line.newLine ?? ""}</td>
                <td style={{ width: 1, padding: "0 4px", color: TEXT_COLOR[entry.line.type], userSelect: "none" }}>{MARKER[entry.line.type]}</td>
                <td style={{ padding: "0 10px", whiteSpace: "pre-wrap", wordBreak: "break-all", color: TEXT_COLOR[entry.line.type] }}>{entry.line.text}</td>
              </tr>
            )
          )}
        </tbody>
      </table>
    </div>
  );
}
```

3d. Pending-highlight resolution in `DiffView` (add imports `useEffect`, `useUIStore`):

```tsx
export function DiffView({ node, diff }: { node: Node; diff?: NodeDiff }) {
  const lines = diff?.lines ?? [];
  const pending = useUIStore((s) => s.pendingAnchorHighlight);
  const setLineSelection = useUIStore((s) => s.setLineSelection);
  const clearAnchorHighlight = useUIStore((s) => s.clearAnchorHighlight);

  useEffect(() => {
    if (!pending || lines.length === 0) return;
    const rows = resolveAnchorRows(lines, pending);
    if (rows) {
      setLineSelection({ ...rows, anchor: pending, label: selectionLabel(pending) });
    }
    clearAnchorHighlight(); // resolved or not: the request is consumed (stale anchors no-op)
  }, [pending, lines]);
  // …rest unchanged
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/web/test/DiffView.test.tsx`
Expected: PASS (including the pre-existing DiffView tests — gap rendering and row content unchanged).

- [ ] **Step 5: Typecheck, commit**

Run: `pnpm -r typecheck` — green.

```bash
git add packages/web/src/components/DiffView.tsx packages/web/test/DiffView.test.tsx
git commit -m "feat(web): diff line selection with anchor derivation and highlight"
```

---

### Task 5: CommentBox — selection chip, anchored submit, anchored-comment display

**Files:**
- Modify: `packages/web/src/components/CommentBox.tsx`
- Test: `packages/web/test/CommentBox.test.tsx` (append)

**Interfaces:**
- Consumes: `useUIStore` (`lineSelection`, `setLineSelection`, `requestAnchorHighlight`), `selectionLabel` from `./DiffView.js`, mutation arg `{ nodeId, text, anchor? }` (Task 3).
- Produces: final user-facing behavior; no new exports.

- [ ] **Step 1: Write the failing tests**

Append to `packages/web/test/CommentBox.test.tsx` (the file mocks `../src/api/hooks.js`; the store is real — set it in tests):

```ts
import { useUIStore } from "../src/store/ui.js";

const anchor = { startLine: 11, startSide: "new" as const, endLine: 12, endSide: "new" as const };

describe("anchored comments", () => {
  beforeEach(() => {
    mutateSpy.mockClear();
    useUIStore.setState({ lineSelection: null, pendingAnchorHighlight: null });
  });

  it("shows the selection chip and submits the anchor", async () => {
    useUIStore.setState({ lineSelection: { startIdx: 2, endIdx: 3, anchor, label: "lines +11…+12" } });
    renderWithProviders(<CommentBox sessionId="s1" nodeId="n1" />);
    expect(screen.getByText(/lines \+11…\+12/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Leave a review comment/), { target: { value: "on these lines" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() =>
      expect(mutateSpy).toHaveBeenCalledWith({ nodeId: "n1", text: "on these lines", anchor }, expect.anything())
    );
    expect(useUIStore.getState().lineSelection).toBeNull(); // cleared on success
  });

  it("clears the selection via the chip's ✕ without commenting", () => {
    useUIStore.setState({ lineSelection: { startIdx: 2, endIdx: 3, anchor, label: "lines +11…+12" } });
    renderWithProviders(<CommentBox sessionId="s1" nodeId="n1" />);
    fireEvent.click(screen.getByLabelText("clear line selection"));
    expect(useUIStore.getState().lineSelection).toBeNull();
  });

  it("renders an anchored comment with a line chip that requests re-highlight", () => {
    // extend the mocked useComments data with an anchored comment for this test:
    // update the vi.mock factory's comments array to include
    // { id: "c2", …, text: "anchored one", anchor: { startLine: 11, startSide: "new", endLine: 12, endSide: "new" } }
    renderWithProviders(<CommentBox sessionId="s1" nodeId="n1" />);
    fireEvent.click(screen.getByText(/lines \+11…\+12/));
    expect(useUIStore.getState().pendingAnchorHighlight).toEqual(anchor);
  });

  it("submits without anchor when there is no selection (unchanged payload)", async () => {
    renderWithProviders(<CommentBox sessionId="s1" nodeId="n1" />);
    fireEvent.change(screen.getByPlaceholderText(/Leave a review comment/), { target: { value: "plain" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() =>
      expect(mutateSpy).toHaveBeenCalledWith({ nodeId: "n1", text: "plain" }, expect.anything())
    );
  });
});
```

Adjust the existing `vi.mock` factory: give the mocked comment `anchor: null`, and add the anchored comment `c2` above. The pre-existing "submits only nodeId and text" test keeps passing because the payload omits `anchor` when there's no selection.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/web/test/CommentBox.test.tsx`
Expected: new tests FAIL (no chip, anchor not submitted).

- [ ] **Step 3: Implement**

In `packages/web/src/components/CommentBox.tsx` (imports: `useUIStore` from `../store/ui.js`, `selectionLabel` from `./DiffView.js`):

```tsx
  const lineSelection = useUIStore((s) => s.lineSelection);
  const setLineSelection = useUIStore((s) => s.setLineSelection);
  const requestAnchorHighlight = useUIStore((s) => s.requestAnchorHighlight);

  const handleSubmit = () => {
    if (!text.trim()) return;
    createComment.mutate(
      lineSelection
        ? { nodeId, text: text.trim(), anchor: lineSelection.anchor }
        : { nodeId, text: text.trim() },
      {
        onSuccess: () => {
          setText("");
          setLineSelection(null);
          updateStatus.mutate({ nodeId, reviewStatus: "reviewed-commented" });
        },
      }
    );
  };
```

Selection chip, rendered between the header row and the comment list:

```tsx
      {lineSelection && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span
            style={{
              fontSize: 15, fontFamily: "var(--mono)", color: "var(--text)",
              background: "var(--surface)", border: "1px solid var(--line-bright)",
              borderRadius: 4, padding: "2px 8px",
            }}
          >
            commenting on {lineSelection.label}
          </span>
          <button
            aria-label="clear line selection"
            className="btn"
            onClick={() => setLineSelection(null)}
            style={{ fontSize: 14, padding: "1px 7px" }}
          >
            ✕
          </button>
        </div>
      )}
```

Anchored-comment display — inside the comments map, before `{c.text}`:

```tsx
              {c.anchor && (
                <button
                  onClick={() => requestAnchorHighlight(c.anchor!)}
                  style={{
                    display: "inline-block", marginRight: 8, fontSize: 14,
                    fontFamily: "var(--mono)", color: "var(--dim)",
                    background: "transparent", border: "1px solid var(--line)",
                    borderRadius: 4, padding: "0 6px", cursor: "pointer",
                  }}
                >
                  {selectionLabel(c.anchor)}
                </button>
              )}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/web/test/CommentBox.test.tsx packages/web/test/DiffView.test.tsx`
Expected: PASS (all, incl. pre-existing).

- [ ] **Step 5: Full suites, typecheck, commit**

Run: `pnpm vitest run` and `pnpm -r typecheck` — everything green.

```bash
git add packages/web/src/components/CommentBox.tsx packages/web/test/CommentBox.test.tsx
git commit -m "feat(web): line-selection chip, anchored comment submit and display"
```

---

### Task 6: Checkpoint — live verification in the browser

**Files:** none (verification only).

- [ ] **Step 1: Build and restart the dogfood server**

```bash
pnpm build
```

Kill and restart the running hub (same command/env as the Phase 1 dogfood: cwd = the sample-project repo, `PORT=3456`; the DB migrates 3→4 on open). Create a fresh session + plan via the orchestrate CLI if the old session's data is awkward.

- [ ] **Step 2: Drive the flow in the browser (Playwright)**

- Open a changed node's diff, click an added line, shift-click another → highlight bar + "commenting on lines +X…+Y" chip appear.
- Send a comment → it renders with the line chip; server stored a range-scoped snippet (verify via `GET /api/sessions/:id/comments`).
- Click the comment's line chip → the range re-highlights.
- Send a node-level comment with no selection → renders without chip, API payload has no anchor.
- `GET /api/sessions/:id/export` → the anchored comment carries `anchor`; screenshot the anchored-comment UI for the record.

- [ ] **Step 3: Commit any checkpoint notes**

Append a short verification note to `docs/superpowers/specs/2026-07-16-line-comments-design.md` (status line → "implemented + verified <date>") and commit:

```bash
git add docs/superpowers/specs/2026-07-16-line-comments-design.md
git commit -m "docs: line comments verified live"
```

---

## Self-review notes (spec → plan)

- Data model (one JSON `anchor` column, v4 migration, types) → Task 1. ✓
- Validation semantics (changed-line endpoints, rendered-order range, residual-aware diff, 400 no-fallback, range-scoped snippet) → Task 2 (`anchorRowRange` + route). ✓
- All-or-nothing optional anchor / node-level unchanged → schema `.optional()` (Task 2), conditional payloads (Tasks 3, 5), regression tests kept green. ✓
- UI (click/shift-click, toggle-clear, inert context rows, highlight, chip + ✕, anchored display chip, re-highlight, selection reset on node change, not persisted) → Tasks 3–5. ✓
- Export carries `anchor` verbatim, GitHub-mappable; no GitHub fields server-side → Tasks 1–2. ✓
- Out of scope respected: no GitHub posting, no re-anchoring, no threads. ✓
- Type consistency: `CommentAnchor`/`AnchorSide` defined server (types.ts) and web (client.ts); `LineSelection` (store) consumed by Tasks 4–5; `selectionLabel` defined Task 4, consumed Task 5; server `anchorRowRange` and client `resolveAnchorRows` deliberately parallel. ✓
