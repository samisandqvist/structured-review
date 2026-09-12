# P1 Structural Value Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the remaining P1 roadmap items from `docs/software-viability-usability-implementation-findings.md`: trustworthy diff line coordinates, a Relations drawer with breadcrumb return, server-populated comment hunk snippets + structural context, and runtime API validation.

**Architecture:** The server's `diff.ts` gains a hunk-coordinate-preserving `DiffLine[]` model that everything else builds on: the web diff pane renders it directly (replacing `react-diff-viewer-continued`'s client-side re-diff), and comment hunk snippets are formatted from it server-side at creation time. Structural context is derived at export time from stored session edges (never client-trusted). The Relations drawer is pure web work — the node-detail endpoint already returns `callers`/`callees`, currently discarded by `SplitLayout`; the dead `walkPath` state in the zustand store becomes the breadcrumb stack. Runtime validation is a thin zod layer applied to every mutating route, added last so it validates the final request shapes.

**Tech Stack:** TypeScript ESM (all relative imports end in `.js`), Hono, better-sqlite3, React 19, zustand, @tanstack/react-query, Vitest 3, zod (new dependency, server only).

## Global Constraints

- Package manager is **pnpm** (never npm). Run tests with `pnpm test` from the repo root (runs all three packages; currently **142 tests / 19 files, all green** — must stay green plus new tests). Typecheck with `pnpm typecheck`.
- Work on branch **`feat/p1-structural`** off `main`.
- All source imports use ESM `.js` suffixes (`import ... from "../db/connection.js"`).
- Server API base path is `/api`; routes live in `packages/server/src/routes/`, DB access in `packages/server/src/repo/`.
- Web API types are hand-duplicated in `packages/web/src/api/client.ts` — every server DTO change must be mirrored there.
- Commit messages: conventional (`feat(server): ...`), each ending with the line `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Do not modify `packages/skill` (it reads only `.comments` from the export response — the additive envelope change keeps it working — and never posts comments).

---

### Task 1: Server — hunk-coordinate `DiffLine` model

**Files:**
- Modify: `packages/server/src/diff.ts` (interfaces at ~line 20–46, `getNodeDiff` at 194–224, `extractHunkDiff` at 233–269, `sliceBoth` at 323–326, `parseHunks` at 328–343)
- Modify: `packages/server/src/routes/nodes.ts:32` (empty-diff fallback)
- Test: `packages/server/test/diff.test.ts`

**Interfaces:**
- Consumes: existing `parseHunks`, `readSlice`.
- Produces: `export interface DiffLine { type: "context" | "added" | "removed"; oldLine: number | null; newLine: number | null; text: string }`; `NodeDiff` becomes `{ oldText: string; newText: string; lines: DiffLine[] }`. Tasks 2–3 rely on `NodeDiff.lines` exactly as typed here.

- [ ] **Step 1: Write the failing tests** — append to `packages/server/test/diff.test.ts` (import `extractHunkDiff` and the `DiffLine` type from `../src/diff.js` as the file already imports diff helpers):

```ts
describe("extractHunkDiff line coordinates", () => {
  const raw = [
    "diff --git a/f.ts b/f.ts",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -10,4 +10,4 @@",
    " line ten",
    "-old eleven",
    "+new eleven",
    " line twelve",
    " line thirteen",
  ].join("\n");

  it("tracks both old and new file line numbers through a hunk", () => {
    const d = extractHunkDiff(raw, 10, 13)!;
    expect(d.lines).toEqual([
      { type: "context", oldLine: 10, newLine: 10, text: "line ten" },
      { type: "removed", oldLine: 11, newLine: null, text: "old eleven" },
      { type: "added", oldLine: null, newLine: 11, text: "new eleven" },
      { type: "context", oldLine: 12, newLine: 12, text: "line twelve" },
      { type: "context", oldLine: 13, newLine: 13, text: "line thirteen" },
    ]);
  });

  it("derives oldText/newText from the same lines", () => {
    const d = extractHunkDiff(raw, 10, 13)!;
    expect(d.oldText).toBe("line ten\nold eleven\nline twelve\nline thirteen");
    expect(d.newText).toBe("line ten\nnew eleven\nline twelve\nline thirteen");
  });

  it("tracks old-line drift across earlier hunks", () => {
    // An earlier hunk that adds 2 lines shifts the second hunk's old numbers.
    const twoHunks = [
      "@@ -1,1 +1,3 @@",
      " top",
      "+ins a",
      "+ins b",
      "@@ -20,2 +22,2 @@",
      " ctx",
      "-gone",
      "+here",
    ].join("\n");
    const d = extractHunkDiff(twoHunks, 22, 23)!;
    expect(d.lines).toEqual([
      { type: "context", oldLine: 20, newLine: 22, text: "ctx" },
      { type: "removed", oldLine: 21, newLine: null, text: "gone" },
      { type: "added", oldLine: null, newLine: 23, text: "here" },
    ]);
  });
});
```

Also find the existing `getNodeDiff` test that covers an **unchanged** node (it asserts `oldText === newText` from a temp-repo slice) and add one assertion to it: `expect(d.lines[0]).toEqual({ type: "context", oldLine: <that test's startLine>, newLine: <same>, text: <first sliced line> });` — unchanged context lines must be numbered from the node's real `startLine`.

- [ ] **Step 2: Run tests to verify they fail** — `pnpm --filter @srev/server test`. Expected: new tests FAIL (`lines` is undefined / type error mentions `lines` missing on `NodeDiff`).

- [ ] **Step 3: Implement.** In `packages/server/src/diff.ts`:

Replace the `NodeDiff` interface and add `DiffLine`:

```ts
export interface DiffLine {
  type: "context" | "added" | "removed";
  /** Real old-file line number (null for added lines). */
  oldLine: number | null;
  /** Real new-file line number (null for removed lines). */
  newLine: number | null;
  text: string;
}

export interface NodeDiff {
  oldText: string;
  newText: string;
  lines: DiffLine[];
}
```

Extend the private `Hunk` interface with `oldStart: number` and capture it in `parseHunks` — change the header regex and constructor:

```ts
const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
if (header) {
  current = { oldStart: Number(header[1]), newStart: Number(header[2]), newCount: Number(header[3] ?? "1"), lines: [] };
  hunks.push(current);
  continue;
}
```

Rewrite `extractHunkDiff` to build `DiffLine[]` (same span semantics as before — a removed line is attributed to the upcoming new-file position):

```ts
export function extractHunkDiff(rawDiff: string, startLine: number, endLine: number): NodeDiff | null {
  const lines: DiffLine[] = [];
  for (const h of parseHunks(rawDiff)) {
    let oldLine = h.oldStart;
    let newLine = h.newStart;
    for (const line of h.lines) {
      const marker = line[0];
      const text = line.slice(1);
      const inSpan = newLine >= startLine && newLine <= endLine;
      if (marker === " ") {
        if (inSpan) lines.push({ type: "context", oldLine, newLine, text });
        oldLine++;
        newLine++;
      } else if (marker === "+") {
        if (inSpan) lines.push({ type: "added", oldLine: null, newLine, text });
        newLine++;
      } else {
        // Removed line: no new-file line of its own; attribute it to the new
        // position it sits at (the upcoming new line).
        if (inSpan) lines.push({ type: "removed", oldLine, newLine: null, text });
        oldLine++;
      }
    }
  }
  if (lines.length === 0) return null;
  return withTexts(lines);
}

function withTexts(lines: DiffLine[]): NodeDiff {
  return {
    oldText: lines.filter((l) => l.type !== "added").map((l) => l.text).join("\n"),
    newText: lines.filter((l) => l.type !== "removed").map((l) => l.text).join("\n"),
    lines,
  };
}

function contextLines(slice: string, startLine: number): DiffLine[] {
  if (!slice) return [];
  return slice.split("\n").map((text, i) => ({
    type: "context" as const,
    oldLine: startLine + i,
    newLine: startLine + i,
    text,
  }));
}
```

Update every `NodeDiff` construction site to go through the helpers:
- `getNodeDiff` unchanged branch (line ~202) and its catch branch (line ~217): `return withTexts(contextLines(readSlice(root, file, startLine, endLine), startLine));`
- `sliceBoth` (line ~323): `return withTexts(contextLines(readSlice(root, file, startLine, endLine), startLine));`
- `packages/server/src/routes/nodes.ts:32`: replace `{ oldText: "", newText: "" }` with `{ oldText: "", newText: "", lines: [] }`.

Note: `withTexts(contextLines("", ...))` would produce `{oldText: "", newText: "", lines: []}` — acceptable, matches old behavior for missing files.

- [ ] **Step 4: Run tests** — `pnpm --filter @srev/server test` then `pnpm typecheck`. Expected: all server tests PASS (existing `oldText`/`newText` assertions must pass unmodified — texts are now derived from lines). Typecheck will fail in `packages/web` only if it references `NodeDiff` from server — it doesn't (types are duplicated), so full typecheck should PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/diff.ts packages/server/src/routes/nodes.ts packages/server/test/diff.test.ts
git commit -m "feat(server): preserve real hunk coordinates in node diffs (DiffLine model)"
```

---

### Task 2: Web — hunk-aware diff rendering with real gutters

**Files:**
- Modify: `packages/web/src/api/client.ts:24` (`NodeDiff`, add `DiffLine`)
- Modify: `packages/web/src/components/DiffView.tsx` (replace `ReactDiffViewer` usage)
- Modify: `packages/web/package.json` (drop `react-diff-viewer-continued`)
- Modify: `packages/web/test/DiffView.test.tsx`, `packages/web/test/SplitLayout.test.tsx:20` (mock diffs gain `lines`)

**Interfaces:**
- Consumes: `NodeDiff.lines: DiffLine[]` from Task 1 (mirrored client-side).
- Produces: `DiffView({ node, diff })` renders a unified table where each `<tr>` has `data-line-type="context"|"added"|"removed"` and two gutter cells with real old/new numbers. Task 4 renders `RelationsPanel` below this component.

- [ ] **Step 1: Write the failing tests.** In `packages/web/test/DiffView.test.tsx`, update the existing mock diff object(s) to the new shape and add:

```tsx
const diff: NodeDiff = {
  oldText: "const a = 1;\nconst b = 2;",
  newText: "const a = 1;\nconst b = 3;",
  lines: [
    { type: "context", oldLine: 10, newLine: 10, text: "const a = 1;" },
    { type: "removed", oldLine: 11, newLine: null, text: "const b = 2;" },
    { type: "added", oldLine: null, newLine: 11, text: "const b = 3;" },
  ],
};

it("renders real file line numbers from hunk coordinates", () => {
  render(<DiffView node={node} diff={diff} />);
  const addedRow = screen.getByText("const b = 3;").closest("tr")!;
  expect(addedRow).toHaveAttribute("data-line-type", "added");
  expect(addedRow.textContent).toContain("11");
  const removedRow = screen.getByText("const b = 2;").closest("tr")!;
  expect(removedRow).toHaveAttribute("data-line-type", "removed");
});

it("renders a gap separator between discontinuous regions", () => {
  const gappy: NodeDiff = {
    oldText: "a\nz", newText: "a\nz",
    lines: [
      { type: "context", oldLine: 1, newLine: 1, text: "a" },
      { type: "context", oldLine: 30, newLine: 30, text: "z" },
    ],
  };
  render(<DiffView node={node} diff={gappy} />);
  expect(screen.getByTestId("diff-gap")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm --filter @srev/web test`. Expected: FAIL (no `data-line-type` rows; old component renders via ReactDiffViewer).

- [ ] **Step 3: Implement.** In `packages/web/src/api/client.ts` replace line 24:

```ts
export interface DiffLine {
  type: "context" | "added" | "removed";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}
export interface NodeDiff { oldText: string; newText: string; lines: DiffLine[]; }
```

Rewrite `packages/web/src/components/DiffView.tsx`: keep the existing header block (label, `NodeBadge`, `context · unchanged` chip, `file:start–end`) exactly as is; replace the `ReactDiffViewer` body with a custom renderer. Full new body:

```tsx
import type { CSSProperties } from "react";
import type { DiffLine, Node, NodeDiff } from "../api/client.js";
import { NodeBadge } from "./NodeBadge.js";

const ROW_BG: Record<DiffLine["type"], string> = {
  context: "transparent",
  added: "rgba(70, 211, 138, 0.13)",
  removed: "rgba(248, 90, 90, 0.13)",
};
const TEXT_COLOR: Record<DiffLine["type"], string> = {
  context: "#e8ecf4",
  added: "#cfeede",
  removed: "#f4cfcb",
};
const MARKER: Record<DiffLine["type"], string> = { context: " ", added: "+", removed: "-" };

const gutterStyle: CSSProperties = {
  width: 1, minWidth: 44, padding: "0 8px", textAlign: "right",
  color: "#5c6678", background: "#0f141e", userSelect: "none",
  fontSize: 13, verticalAlign: "top",
};

/** Insert "gap" markers where consecutive lines skip file positions (hunk boundaries). */
function withSeparators(lines: DiffLine[]): (DiffLine | "gap")[] {
  const out: (DiffLine | "gap")[] = [];
  let lastOld: number | null = null;
  let lastNew: number | null = null;
  for (const l of lines) {
    const oldGap = l.oldLine !== null && lastOld !== null && l.oldLine > lastOld + 1;
    const newGap = l.newLine !== null && lastNew !== null && l.newLine > lastNew + 1;
    if (out.length > 0 && (oldGap || newGap)) out.push("gap");
    out.push(l);
    if (l.oldLine !== null) lastOld = l.oldLine;
    if (l.newLine !== null) lastNew = l.newLine;
  }
  return out;
}

function DiffLines({ lines }: { lines: DiffLine[] }) {
  return (
    <div style={{ border: "1px solid #283143", borderRadius: 8, overflow: "hidden", background: "#11151f" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--mono)", fontSize: 15, lineHeight: 1.5 }}>
        <tbody>
          {withSeparators(lines).map((l, i) =>
            l === "gap" ? (
              <tr key={`gap-${i}`} data-testid="diff-gap">
                <td colSpan={4} style={{ padding: "2px 10px", color: "#5c6678", background: "#161c28", fontSize: 12, textAlign: "center" }}>⋯</td>
              </tr>
            ) : (
              <tr key={i} data-line-type={l.type} style={{ background: ROW_BG[l.type] }}>
                <td style={gutterStyle}>{l.oldLine ?? ""}</td>
                <td style={gutterStyle}>{l.newLine ?? ""}</td>
                <td style={{ width: 1, padding: "0 4px", color: TEXT_COLOR[l.type], userSelect: "none" }}>{MARKER[l.type]}</td>
                <td style={{ padding: "0 10px", whiteSpace: "pre-wrap", wordBreak: "break-all", color: TEXT_COLOR[l.type] }}>{l.text}</td>
              </tr>
            )
          )}
        </tbody>
      </table>
    </div>
  );
}
```

In the `DiffView` component body, replace the `hasContent` logic and `ReactDiffViewer` element:

```tsx
const lines = diff?.lines ?? [];
// ...header unchanged...
<div style={{ flex: 1, overflow: "auto" }}>
  {lines.length > 0 ? (
    <DiffLines lines={lines} />
  ) : (
    <div style={{ padding: 16, color: "var(--faint)", fontSize: 13 }}>
      No source available for this node.
    </div>
  )}
</div>
```

Delete the `diffStyles` constant and the `react-diff-viewer-continued` import. Then:

```bash
pnpm --filter @srev/web remove react-diff-viewer-continued
```

Update `packages/web/test/SplitLayout.test.tsx:20` mock: `diff: { oldText: "", newText: "", lines: [] }`.

- [ ] **Step 4: Run tests** — `pnpm --filter @srev/web test && pnpm typecheck`. Expected: PASS (update any old DiffView test that asserted ReactDiffViewer-specific output to assert against the new table).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src packages/web/test packages/web/package.json pnpm-lock.yaml
git commit -m "feat(web): hunk-aware diff renderer with real file line numbers"
```

---

### Task 3: Server + web — auto-populated comment hunk snippets and structural context

**Files:**
- Modify: `packages/server/src/diff.ts` (add `formatHunkSnippet`)
- Modify: `packages/server/src/repo/comments.ts` (export gains structural context + node lines)
- Modify: `packages/server/src/routes/comments.ts` (POST computes snippet, checks ownership; export envelope gains session refs)
- Modify: `packages/server/src/types.ts:64-74` (`ExportedComment` gains `startLine`/`endLine`)
- Modify: `packages/web/src/api/client.ts` (`createComment`, `exportComments` signatures), `packages/web/src/api/hooks.ts:46-57`, `packages/web/src/components/CommentBox.tsx:21-34`
- Test: `packages/server/test/diff.test.ts`, `packages/server/test/repo.test.ts`, `packages/server/test/routes.test.ts`, `packages/server/test/e2e.test.ts`, `packages/web/test/CommentBox.test.tsx`

**Interfaces:**
- Consumes: `NodeDiff.lines` (Task 1); `getNodeNeighbors(db, nodeId)` from `packages/server/src/repo/nodes.ts:40`; `getSession`/`getNode` repo functions; `getNodeDiff` from `diff.js`.
- Produces: `formatHunkSnippet(lines: DiffLine[], maxLines?: number, maxChars?: number): string`; `structuralContextFor(db: DB, nodeId: string): string` (exported from `repo/comments.ts`); POST body shrinks to `{ nodeId, text }` (extra legacy fields ignored); export response becomes `{ branch, baseRef, headSha, comments }` with `comments[]` entries gaining `startLine`/`endLine` and populated `hunkSnippet`/`structuralContext`. Task 5 validates the new POST body shape; Task 6 documents it.

- [ ] **Step 1: Write failing unit tests.** In `packages/server/test/diff.test.ts`:

```ts
describe("formatHunkSnippet", () => {
  const lines = [
    { type: "context" as const, oldLine: 1, newLine: 1, text: "a" },
    { type: "context" as const, oldLine: 2, newLine: 2, text: "b" },
    { type: "context" as const, oldLine: 3, newLine: 3, text: "c" },
    { type: "context" as const, oldLine: 4, newLine: 4, text: "d" },
    { type: "removed" as const, oldLine: 5, newLine: null, text: "old" },
    { type: "added" as const, oldLine: null, newLine: 5, text: "new" },
    { type: "context" as const, oldLine: 6, newLine: 6, text: "e" },
  ];

  it("windows around the changed lines with two context lines", () => {
    expect(formatHunkSnippet(lines).split("\n")).toEqual([
      "     3 c",
      "     4 d",
      "-    5 old",
      "+    5 new",
      "     6 e",
    ]);
  });

  it("caps line count", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      type: "added" as const, oldLine: null, newLine: i + 1, text: `l${i}`,
    }));
    expect(formatHunkSnippet(many, 10).split("\n")).toHaveLength(10);
  });

  it("uses the whole (bounded) fragment when nothing changed", () => {
    const ctx = lines.filter((l) => l.type === "context");
    expect(formatHunkSnippet(ctx).split("\n")).toHaveLength(ctx.length);
  });

  it("returns empty string for no lines", () => {
    expect(formatHunkSnippet([])).toBe("");
  });
});
```

In `packages/server/test/repo.test.ts` (follow the file's existing memory-db setup style; `createSession(db, branch, baseRef, headSha, fingerprint)` and `createNode(db, {...})` signatures are in `repo/sessions.ts` / `repo/nodes.ts`):

```ts
it("structuralContextFor lists callers, callees, and tests", () => {
  const db = createMemoryDatabase();
  const session = createSession(db, "HEAD", "main", "sha", "fp");
  const base = { sessionId: session.id, startLine: 1, endLine: 5, changeStatus: "changed" as const, reviewStatus: "unreviewed" as const, reviewedInUnit: null, isTest: false };
  const a = createNode(db, { ...base, stableId: "fn:a", label: "a", file: "src/a.ts" });
  const b = createNode(db, { ...base, stableId: "fn:b", label: "b", file: "src/b.ts" });
  const c = createNode(db, { ...base, stableId: "fn:c", label: "c", file: "src/c.ts" });
  const t = createNode(db, { ...base, stableId: "fn:t", label: "t", file: "test/t.ts", isTest: true });
  const addEdge = db.prepare("INSERT INTO edges (id, session_id, source_node_id, target_node_id, edge_type) VALUES (?, ?, ?, ?, ?)");
  addEdge.run("e1", session.id, b.id, a.id, "call"); // b calls a
  addEdge.run("e2", session.id, a.id, c.id, "call"); // a calls c
  addEdge.run("e3", session.id, t.id, a.id, "test"); // t tests a
  expect(structuralContextFor(db, a.id)).toBe(
    "called by: b (src/b.ts:1); calls: c (src/c.ts:1); tested by: t (test/t.ts:1)"
  );
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @srev/server test`. Expected: FAIL (functions don't exist).

- [ ] **Step 3: Implement the helpers.** In `packages/server/src/diff.ts`:

```ts
/**
 * Bounded, human-readable fragment of a node's diff for comment export:
 * a window from two lines before the first changed line through two after
 * the last (the whole fragment when nothing changed), capped in lines and
 * characters. Format: marker + right-aligned file line number + text.
 */
export function formatHunkSnippet(lines: DiffLine[], maxLines = 40, maxChars = 2000): string {
  if (lines.length === 0) return "";
  const firstChanged = lines.findIndex((l) => l.type !== "context");
  const lastChanged = firstChanged === -1
    ? lines.length - 1
    : lines.length - 1 - [...lines].reverse().findIndex((l) => l.type !== "context");
  const from = Math.max(0, (firstChanged === -1 ? 0 : firstChanged) - 2);
  const to = Math.min(lines.length - 1, lastChanged + 2);
  const window = lines.slice(from, Math.min(to + 1, from + maxLines));
  const out: string[] = [];
  let chars = 0;
  for (const l of window) {
    const s = `${MARKER_CHAR[l.type]}${String(l.newLine ?? l.oldLine ?? 0).padStart(5)} ${l.text}`;
    if (chars + s.length > maxChars) break;
    out.push(s);
    chars += s.length + 1;
  }
  return out.join("\n");
}

const MARKER_CHAR: Record<DiffLine["type"], string> = { context: " ", added: "+", removed: "-" };
```

In `packages/server/src/repo/comments.ts` add (import `getNodeNeighbors` from `./nodes.js` and `Node` type):

```ts
/** Derived at export time from stored session edges — never client-authored. */
export function structuralContextFor(db: DB, nodeId: string): string {
  const { callers, callees } = getNodeNeighbors(db, nodeId);
  const fmt = (n: Node) => `${n.label} (${n.file}:${n.startLine})`;
  const callerFns = callers.filter((n) => !n.isTest);
  const tests = callers.filter((n) => n.isTest);
  const parts: string[] = [];
  if (callerFns.length) parts.push(`called by: ${callerFns.map(fmt).join(", ")}`);
  if (callees.length) parts.push(`calls: ${callees.map(fmt).join(", ")}`);
  if (tests.length) parts.push(`tested by: ${tests.map(fmt).join(", ")}`);
  return parts.join("; ");
}
```

Update `exportComments` in the same file: add `n.start_line, n.end_line` to the SELECT, add them to the row type, and build:

```ts
return rows.map((row) => ({
  id: row.id, nodeId: row.node_id, stableId: row.stable_id, label: row.label, file: row.file,
  startLine: row.start_line, endLine: row.end_line,
  hunkSnippet: row.hunk_snippet, text: row.text,
  structuralContext: structuralContextFor(db, row.node_id),
  createdAt: row.created_at,
}));
```

Add `startLine: number; endLine: number;` to `ExportedComment` in `packages/server/src/types.ts` (after `file`).

- [ ] **Step 4: Rewrite the comments route.** `packages/server/src/routes/comments.ts` in full:

```ts
import { Hono } from "hono";
import type { AppContext } from "../app.js";
import { createComment, getCommentsBySession, exportComments } from "../repo/comments.js";
import { getSession } from "../repo/sessions.js";
import { getNode } from "../repo/nodes.js";
import { getNodeDiff, formatHunkSnippet } from "../diff.js";

export function createCommentsRoute(ctx: AppContext) {
  const router = new Hono();

  router.get("/:id/comments", (c) => {
    return c.json({ comments: getCommentsBySession(ctx.db, c.req.param("id")) });
  });

  router.post("/:id/comments", async (c) => {
    const sessionId = c.req.param("id");
    const body = await c.req.json<{ nodeId: string; text: string }>();
    const session = getSession(ctx.db, sessionId);
    if (!session) return c.json({ error: "not found" }, 404);
    const node = getNode(ctx.db, body.nodeId);
    if (!node || node.sessionId !== sessionId) return c.json({ error: "node not found in session" }, 404);
    // The snippet is derived server-side from what the diff pane shows for this
    // node right now — client-authored context is not trusted (findings doc).
    const diff = getNodeDiff(session.baseRef, node.file, node.startLine, node.endLine, node.changeStatus, ctx.repoRoot);
    const comment = createComment(ctx.db, sessionId, body.nodeId, formatHunkSnippet(diff.lines), body.text, "");
    return c.json({ comment });
  });

  router.get("/:id/export", (c) => {
    const session = getSession(ctx.db, c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    return c.json({
      branch: session.branch,
      baseRef: session.baseRef,
      headSha: session.headSha,
      comments: exportComments(ctx.db, session.id),
    });
  });

  return router;
}
```

- [ ] **Step 5: Update route/e2e tests.** In `packages/server/test/routes.test.ts`:
  - Existing comment tests still send `hunkSnippet`/`structuralContext` in POST bodies — leave the extra fields (route ignores them) but update any assertion that echoed them back: stored `hunkSnippet` is now server-derived (empty string in stub-provider tests, whose node files don't exist on disk) and `structuralContext` is `""` on the stored comment.
  - Existing export-shape assertions: response now has `branch`/`baseRef`/`headSha` alongside `comments`; exported entries gain `startLine`/`endLine`, and `structuralContext` is derived (for the stub graph, `fn:handleOrder` → expect it to mention its stub callees per `StubGraphProvider`'s edges as persisted by session creation).
  - New tests:

```ts
it("rejects a comment for a node from another session", async () => {
  // create session A and session B (two POST /api/sessions calls),
  // read a node id from B via GET /api/sessions/:idB/nodes,
  const res = await app.request(`/api/sessions/${idA}/comments`, {
    method: "POST",
    body: JSON.stringify({ nodeId: nodeFromB.id, text: "cross-session" }),
    headers: { "Content-Type": "application/json" },
  });
  expect(res.status).toBe(404);
});

it("export includes the session's git anchors", async () => {
  const res = await app.request(`/api/sessions/${id}/export`);
  const body = await res.json();
  expect(body.branch).toBe("HEAD");
  expect(typeof body.headSha).toBe("string");
  expect(body.baseRef).toBeTruthy();
});
```

  In `packages/server/test/e2e.test.ts` (real SCIP fixture: `helper.ts` called by `handler.ts`, tested by `handler.test.ts`), extend the existing export assertions: the exported comments on the changed node must have a non-empty `hunkSnippet` containing a `"+"`-prefixed line, and `structuralContext` naming a real neighbor (assert with the fixture's actual labels once read — e.g. `expect(exported.comments[0].structuralContext).toContain("helper")` if the comment sits on the handler node). Update the POST bodies in this file to `{ nodeId, text }`.

- [ ] **Step 6: Update the web client.** `packages/web/src/api/client.ts`:

```ts
createComment: (id: string, nodeId: string, text: string) =>
  fetchJson<{ comment: Comment }>(`/sessions/${id}/comments`, {
    method: "POST", body: JSON.stringify({ nodeId, text }),
  }),
exportComments: (id: string) =>
  fetchJson<{ branch: string; baseRef: string; headSha: string; comments: Record<string, unknown>[] }>(
    `/sessions/${id}/export`
  ),
```

`packages/web/src/api/hooks.ts` `useCreateComment` mutationFn becomes `({ nodeId, text }: { nodeId: string; text: string }) => api.createComment(sessionId, nodeId, text)`. `packages/web/src/components/CommentBox.tsx:24` becomes `createComment.mutate({ nodeId, text: text.trim() }, ...)`. Update `packages/web/test/CommentBox.test.tsx` expected mutate args accordingly.

- [ ] **Step 7: Run everything** — `pnpm test && pnpm typecheck`. Expected: PASS (e2e takes up to ~2 min, real scip-typescript).

- [ ] **Step 8: Commit**

```bash
git add packages/server packages/web
git commit -m "feat(server): server-derived comment hunk snippets and export structural context"
```

---

### Task 4: Web — Relations drawer with breadcrumb return path

**Files:**
- Create: `packages/web/src/components/RelationsPanel.tsx`
- Modify: `packages/web/src/store/ui.ts` (replace `popWalkPath` with `truncateWalkPath`)
- Modify: `packages/web/src/components/SplitLayout.tsx` (render panel + breadcrumb, wire selection semantics)
- Test: `packages/web/test/RelationsPanel.test.tsx` (new), `packages/web/test/SplitLayout.test.tsx`

**Interfaces:**
- Consumes: `useNode(...)`'s already-fetched `callers: Node[]` / `callees: Node[]` (currently discarded in `SplitLayout.tsx:20`); `buildWalkOrder` result (already computed in `SplitLayout` as `order`); zustand `walkPath: string[]` + `pushToWalkPath`.
- Produces: `RelationsPanel({ callers, callees, walkStableIds, onSelect })`; store action `truncateWalkPath(index: number)`; breadcrumb bar with `data-testid="breadcrumb"`, per-crumb buttons, and `data-testid="return-to-walk"`.

Semantics (from the findings doc): clicking a relation is a **detour** — the current node is pushed onto the breadcrumb stack and the neighbor becomes current. Chained detours stack. "Return to review walk" jumps back to the stack's first entry (where the detour began) and clears it. Clicking crumb *i* returns there and truncates the stack to *i*. Any **walk** move (plan click, `j`/`k`/`n`/`r` navigation) ends the detour: stack cleared.

- [ ] **Step 1: Write failing tests.** New `packages/web/test/RelationsPanel.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import { RelationsPanel } from "../src/components/RelationsPanel.js";
import type { Node } from "../src/api/client.js";

const mk = (over: Partial<Node>): Node => ({
  id: "n-x", sessionId: "s1", stableId: "fn:x", label: "x", file: "src/x.ts",
  startLine: 1, endLine: 9, changeStatus: "unchanged", reviewStatus: "unreviewed",
  reviewedInUnit: null, isTest: false, ...over,
});

describe("RelationsPanel", () => {
  it("shows callers and callees with state chips", () => {
    render(
      <RelationsPanel
        callers={[mk({ id: "n-c", label: "caller", changeStatus: "changed" }), mk({ id: "n-t", label: "spec", isTest: true })]}
        callees={[mk({ id: "n-e", label: "callee" })]}
        walkStableIds={new Set(["fn:x"])}
        onSelect={() => {}}
      />
    );
    expect(screen.getByText("caller")).toBeInTheDocument();
    expect(screen.getByText("callee")).toBeInTheDocument();
    expect(screen.getByText("changed")).toBeInTheDocument();
    expect(screen.getByText("test")).toBeInTheDocument();
    expect(screen.getAllByText("in walk").length).toBeGreaterThan(0);
  });

  it("invokes onSelect with the neighbor's node id", () => {
    const onSelect = vi.fn();
    render(
      <RelationsPanel callers={[mk({ id: "n-c", label: "caller" })]} callees={[]} walkStableIds={new Set()} onSelect={onSelect} />
    );
    fireEvent.click(screen.getByTestId("relation-n-c"));
    expect(onSelect).toHaveBeenCalledWith("n-c");
  });

  it("collapses and expands", () => {
    render(
      <RelationsPanel callers={[mk({ id: "n-c", label: "caller" })]} callees={[]} walkStableIds={new Set()} onSelect={() => {}} />
    );
    fireEvent.click(screen.getByTestId("relations-toggle"));
    expect(screen.queryByText("caller")).not.toBeInTheDocument();
  });

  it("renders nothing without neighbors", () => {
    const { container } = render(
      <RelationsPanel callers={[]} callees={[]} walkStableIds={new Set()} onSelect={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
```

In `packages/web/test/SplitLayout.test.tsx`: add a caller node and route it through the `useNode` mock, reset `walkPath` in `beforeEach`, and add breadcrumb tests:

```tsx
const callerNode = { id: "n-c", stableId: "fn:c", label: "c", file: "g.ts", startLine: 1, endLine: 3, changeStatus: "unchanged", reviewStatus: "unreviewed", reviewedInUnit: null, isTest: false };
const allNodes = [...nodes, callerNode];
// useNode mock becomes:
useNode: (_s: string, nodeId: string | null) => ({
  data: nodeId
    ? {
        node: allNodes.find((n) => n.id === nodeId),
        callers: nodeId === "n-a" ? [callerNode] : [],
        callees: [],
        diff: { oldText: "", newText: "", lines: [] },
      }
    : undefined,
}),
// beforeEach:
useUIStore.setState({ currentNodeId: null, walkPath: [] });

describe("Relations drawer detours", () => {
  it("clicking a relation opens it with a breadcrumb, return goes back to the walk", () => {
    useUIStore.setState({ currentNodeId: "n-a" });
    render(<SplitLayout sessionId="s1" currentNodeId="n-a" />);
    fireEvent.click(screen.getByTestId("relation-n-c"));
    expect(useUIStore.getState().currentNodeId).toBe("n-c");
    expect(useUIStore.getState().walkPath).toEqual(["n-a"]);
    expect(screen.getByTestId("breadcrumb")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("return-to-walk"));
    expect(useUIStore.getState().currentNodeId).toBe("n-a");
    expect(useUIStore.getState().walkPath).toEqual([]);
  });

  it("walk navigation clears a detour breadcrumb", () => {
    useUIStore.setState({ currentNodeId: "n-c", walkPath: ["n-a"] });
    render(<SplitLayout sessionId="s1" currentNodeId="n-c" />);
    fireEvent.keyDown(window, { key: "j" });
    expect(useUIStore.getState().walkPath).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @srev/web test`. Expected: FAIL (`RelationsPanel` module not found; no breadcrumb testids).

- [ ] **Step 3: Implement the store change.** In `packages/web/src/store/ui.ts`: remove `popWalkPath` (dead — nothing calls it) from the interface and implementation; add:

```ts
truncateWalkPath: (index: number) => void;
// impl:
truncateWalkPath: (index) => set((s) => ({ walkPath: s.walkPath.slice(0, index) })),
```

- [ ] **Step 4: Implement `RelationsPanel`.** Create `packages/web/src/components/RelationsPanel.tsx`:

```tsx
import { useState } from "react";
import type { ReactNode } from "react";
import type { Node } from "../api/client.js";
import { NodeBadge } from "./NodeBadge.js";

/**
 * Collapsible local-structure panel under the diff: who calls this node, what
 * it calls, with change/test/walk/review state — bottom-up movement as a local
 * action without a graph view.
 */
export function RelationsPanel({
  callers, callees, walkStableIds, onSelect,
}: {
  callers: Node[];
  callees: Node[];
  walkStableIds: Set<string>;
  onSelect: (nodeId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const rows = [
    ...callers.map((node) => ({ node, direction: "caller" as const })),
    ...callees.map((node) => ({ node, direction: "callee" as const })),
  ];
  if (rows.length === 0) return null;

  return (
    <section data-testid="relations-panel" style={{ marginTop: 14 }}>
      <button
        data-testid="relations-toggle"
        onClick={() => setOpen((v) => !v)}
        style={{ background: "none", border: "none", color: "var(--dim)", cursor: "pointer", padding: 0, fontSize: 13, letterSpacing: "0.05em" }}
      >
        {open ? "▾" : "▸"} RELATIONS · {callers.length} caller{callers.length === 1 ? "" : "s"} · {callees.length} callee{callees.length === 1 ? "" : "s"}
      </button>
      {open && (
        <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          {rows.map(({ node, direction }) => (
            <li key={`${direction}-${node.id}`}>
              <button
                data-testid={`relation-${node.id}`}
                onClick={() => onSelect(node.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                  background: "var(--surface)", border: "1px solid var(--line)",
                  borderRadius: "var(--radius-sm)", padding: "6px 10px", cursor: "pointer",
                  color: "var(--text)", fontSize: 14,
                }}
              >
                <span title={direction === "caller" ? "called by" : "calls"} style={{ color: "var(--dim)", fontFamily: "var(--mono)" }}>
                  {direction === "caller" ? "←" : "→"}
                </span>
                <span style={{ fontFamily: "var(--mono)", fontWeight: 600 }}>{node.label}</span>
                <span style={{ color: "var(--dim)", fontSize: 12 }}>{node.file}:{node.startLine}</span>
                {node.isTest && <Chip>test</Chip>}
                <Chip>{node.changeStatus}</Chip>
                {walkStableIds.has(node.stableId) && <Chip>in walk</Chip>}
                <span style={{ marginLeft: "auto" }}><NodeBadge status={node.reviewStatus} /></span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontSize: 11, color: "var(--dim)", border: "1px solid var(--line-bright)", borderRadius: 4, padding: "0 5px", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}
```

- [ ] **Step 5: Wire into `SplitLayout`.** In `packages/web/src/components/SplitLayout.tsx`:

Add store reads and navigation callbacks (after the existing `goNextUnreviewed`):

```tsx
const walkPath = useUIStore((s) => s.walkPath);
const pushToWalkPath = useUIStore((s) => s.pushToWalkPath);
const truncateWalkPath = useUIStore((s) => s.truncateWalkPath);

// A walk move (plan click, j/k/n/r) ends any detour.
const walkTo = useCallback((nodeId: string | null) => {
  truncateWalkPath(0);
  setCurrentNode(nodeId);
}, [truncateWalkPath, setCurrentNode]);

// A relation click is a detour: remember where we came from.
const selectRelation = useCallback((nodeId: string) => {
  const cur = useUIStore.getState().currentNodeId;
  if (cur) pushToWalkPath(cur);
  setCurrentNode(nodeId);
}, [pushToWalkPath, setCurrentNode]);

const jumpToBreadcrumb = useCallback((index: number) => {
  const path = useUIStore.getState().walkPath;
  if (index < 0 || index >= path.length) return;
  setCurrentNode(path[index]);
  truncateWalkPath(index);
}, [setCurrentNode, truncateWalkPath]);
```

Replace every walk-navigation `setCurrentNode(id)` with `walkTo(id)`:
- `goNextUnreviewed` body: `if (id) walkTo(id);` (and its dep array becomes `[order, nodes, walkTo]`).
- `j`/`k` handlers: `if (id) walkTo(id);` (key-effect deps gain `walkTo`).
- `PlanView` prop: `onSelectNode={walkTo}`.

Compute walk membership next to `order`:

```tsx
const walkStableIds = useMemo(() => new Set(order.map((e) => e.stableId)), [order]);
const nodeLabel = useCallback(
  (id: string) => nodes.find((n) => n.id === id)?.label ?? id,
  [nodes]
);
```

Render the breadcrumb bar just above `<DiffView …>` inside the `currentNode ? (…)` branch, and the panel right after `DiffView` in the same scroll container:

```tsx
<div style={{ flex: 1, overflow: "auto", padding: "12px 14px" }}>
  {walkPath.length > 0 && (
    <div
      data-testid="breadcrumb"
      style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 10, fontSize: 13, color: "var(--dim)" }}
    >
      {walkPath.map((id, i) => (
        <button
          key={`${id}-${i}`}
          onClick={() => jumpToBreadcrumb(i)}
          style={{ background: "none", border: "none", color: "var(--accent, #4fd6ff)", cursor: "pointer", padding: 0, fontSize: 13, fontFamily: "var(--mono)" }}
        >
          {nodeLabel(id)} ›
        </button>
      ))}
      <span style={{ fontFamily: "var(--mono)" }}>{currentNode.label}</span>
      <button data-testid="return-to-walk" className="btn" style={{ marginLeft: "auto" }} onClick={() => jumpToBreadcrumb(0)}>
        ⏎ Return to review walk
      </button>
    </div>
  )}
  <DiffView node={currentNode} diff={nodeData?.diff} />
  <RelationsPanel
    callers={nodeData?.callers ?? []}
    callees={nodeData?.callees ?? []}
    walkStableIds={walkStableIds}
    onSelect={selectRelation}
  />
</div>
```

(`jumpToBreadcrumb(0)` is exactly "return to where the detour began and clear the stack".) Import `RelationsPanel` at the top. `useNode`'s `callers`/`callees` are already in `nodeData` — no hook changes needed.

- [ ] **Step 6: Run tests** — `pnpm --filter @srev/web test && pnpm typecheck`. Expected: PASS, including the pre-existing walk-navigation tests (unchanged semantics — `walkTo` only additionally clears an empty stack).

- [ ] **Step 7: Commit**

```bash
git add packages/web
git commit -m "feat(web): relations drawer with breadcrumb detours and return-to-walk"
```

---

### Task 5: Server — runtime request validation (zod)

**Files:**
- Create: `packages/server/src/validate.ts`
- Modify: `packages/server/package.json` (add `zod`)
- Modify: `packages/server/src/routes/sessions.ts` (POST body, PUT plan, PATCH unit), `packages/server/src/routes/nodes.ts` (PATCH), `packages/server/src/routes/comments.ts` (POST)
- Test: `packages/server/test/routes.test.ts`

**Interfaces:**
- Consumes: final request shapes from Tasks 3 (`{ nodeId, text }` comments) and existing routes; `ReviewStatus` values from `types.ts:4-8`; `PlanUnitInput` semantics from `coverage.ts:3-21` (legacy singular `flowEntryStableId` still accepted).
- Produces: `parseBody(c, schema)` returning `{ ok: true, data } | { ok: false, res }`; all mutating routes return `400 { error: "validation failed", issues: [{ path, message }] }` on bad input and `400 { error: "invalid JSON body" }` on unparseable JSON. Unknown body keys are stripped (legacy clients that still send `hunkSnippet` keep working).

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @srev/server add zod
```

- [ ] **Step 2: Write failing route tests** in `packages/server/test/routes.test.ts` (reuse the file's existing session-creation helpers):

```ts
describe("runtime validation", () => {
  it("rejects session creation without branch/baseRef", async () => {
    const res = await app.request("/api/sessions", {
      method: "POST", body: JSON.stringify({}), headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation failed");
    expect(body.issues.map((i: { path: string }) => i.path)).toContain("branch");
  });

  it("rejects invalid JSON bodies", async () => {
    const res = await app.request("/api/sessions", {
      method: "POST", body: "{not json", headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid JSON body");
  });

  it("rejects a plan unit without a label", async () => {
    // sessionId from the shared created-session helper
    const res = await app.request(`/api/sessions/${sessionId}/plan`, {
      method: "PUT",
      body: JSON.stringify({ units: [{ kind: "orphans", label: "  ", orphanStableIds: ["fn:validateOrder"] }] }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects a flow unit with no entries", async () => {
    const res = await app.request(`/api/sessions/${sessionId}/plan`, {
      method: "PUT",
      body: JSON.stringify({ units: [{ kind: "flow", label: "Order flow" }] }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects the same stableId claimed by two units", async () => {
    const res = await app.request(`/api/sessions/${sessionId}/plan`, {
      method: "PUT",
      body: JSON.stringify({ units: [
        { kind: "orphans", label: "One", orphanStableIds: ["fn:validateOrder"] },
        { kind: "orphans", label: "Two", orphanStableIds: ["fn:validateOrder"] },
      ] }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown review status", async () => {
    const res = await app.request(`/api/sessions/${sessionId}/nodes/${nodeId}`, {
      method: "PATCH",
      body: JSON.stringify({ reviewStatus: "looks-fine" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects an empty unit patch", async () => {
    // unitId from a previously created (non-auto) unit
    const res = await app.request(`/api/sessions/${sessionId}/units/${unitId}`, {
      method: "PATCH", body: JSON.stringify({}), headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects an empty comment", async () => {
    const res = await app.request(`/api/sessions/${sessionId}/comments`, {
      method: "POST",
      body: JSON.stringify({ nodeId, text: "   " }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: Run to verify failure** — `pnpm --filter @srev/server test`. Expected: the new describe FAILS (current routes 500 or accept the input).

- [ ] **Step 4: Implement.** Create `packages/server/src/validate.ts`:

```ts
import { z } from "zod";
import type { Context } from "hono";

export const sessionCreateSchema = z.object({
  branch: z.string().min(1, "branch is required"),
  baseRef: z.string().min(1, "baseRef is required"),
});

const flowUnitSchema = z.object({
  kind: z.literal("flow"),
  label: z.string(),
  rationale: z.string().optional(),
  flowEntryStableId: z.string().min(1).optional(),
  flowEntryStableIds: z.array(z.string().min(1)).optional(),
});

const orphanUnitSchema = z.object({
  kind: z.literal("orphans"),
  label: z.string(),
  rationale: z.string().optional(),
  orphanStableIds: z.array(z.string().min(1)),
});

export const planSchema = z
  .object({ units: z.array(z.union([flowUnitSchema, orphanUnitSchema])) })
  .superRefine((body, ctx) => {
    const seen = new Set<string>();
    body.units.forEach((u, i) => {
      if (!u.label.trim()) {
        ctx.addIssue({ code: "custom", path: ["units", i, "label"], message: "unit label must be nonempty" });
      }
      // Per-unit dedupe first: the legacy singular entry field may repeat the
      // plural one inside a single unit, which flowEntries() already collapses.
      const ids = u.kind === "flow"
        ? new Set([...(u.flowEntryStableIds ?? []), ...(u.flowEntryStableId ? [u.flowEntryStableId] : [])])
        : new Set(u.orphanStableIds);
      if (ids.size === 0) {
        ctx.addIssue({
          code: "custom", path: ["units", i],
          message: u.kind === "flow" ? "flow unit needs at least one entry stableId" : "orphan unit needs at least one member",
        });
      }
      for (const id of ids) {
        if (seen.has(id)) {
          ctx.addIssue({ code: "custom", path: ["units", i], message: `stableId '${id}' appears in more than one unit` });
        }
        seen.add(id);
      }
    });
  });

export const unitPatchSchema = z
  .object({
    label: z.string().trim().min(1, "label must be nonempty").optional(),
    position: z.number().int().nonnegative().optional(),
  })
  .refine((b) => b.label !== undefined || b.position !== undefined, { message: "nothing to update" });

export const nodePatchSchema = z.object({
  reviewStatus: z.enum(["unreviewed", "reviewed-clean", "reviewed-commented", "reviewed-elsewhere"]),
  reviewedInUnit: z.number().int().nonnegative().optional(),
});

export const commentCreateSchema = z.object({
  nodeId: z.string().min(1, "nodeId is required"),
  text: z.string().trim().min(1, "comment text must be nonempty").max(10_000, "comment too long"),
});

export type Parsed<T> = { ok: true; data: T } | { ok: false; res: Response };

/** Parse + validate a JSON body; on failure returns a structured 4xx the
 *  caller returns as-is. Unknown keys are stripped, so older clients that
 *  still send extra fields keep working. */
export async function parseBody<S extends z.ZodTypeAny>(c: Context, schema: S): Promise<Parsed<z.infer<S>>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, res: c.json({ error: "invalid JSON body" }, 400) };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      res: c.json({
        error: "validation failed",
        issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      }, 400),
    };
  }
  return { ok: true, data: result.data };
}
```

Apply in each mutating route — the pattern, shown for `POST /api/sessions` (`routes/sessions.ts:60-61`):

```ts
router.post("/", async (c) => {
  const parsed = await parseBody(c, sessionCreateSchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  // ...rest unchanged
```

Same replacement for:
- `routes/sessions.ts` PUT `/:id/plan` (`planSchema`; the parsed `units` satisfy `PlanUnitInput[]` — keep the existing 404-before-parse order: session lookup first, then `parseBody`).
- `routes/sessions.ts` PATCH `/:id/units/:unitId` (`unitPatchSchema`; keep the existing 404/auto-unit checks before parsing; the manual `typeof body.label === "string" && body.label.trim()` guard simplifies to `if (body.label !== undefined)` since the schema trims and rejects empties).
- `routes/nodes.ts` PATCH (`nodePatchSchema`).
- `routes/comments.ts` POST (`commentCreateSchema`; keep the Task 3 session/node-ownership 404s after parsing).

- [ ] **Step 5: Run tests** — `pnpm test && pnpm typecheck`. Expected: PASS. If a pre-existing test intentionally sent a now-invalid body (e.g. empty-label unit), fix the test's body to be valid unless the test's purpose was to assert the old lenient behavior — in that case update its expectation to 400.

- [ ] **Step 6: Commit**

```bash
git add packages/server pnpm-lock.yaml
git commit -m "feat(server): zod runtime validation with structured 400s on all mutating routes"
```

---

### Task 6: Docs — contracts and findings status

**Files:**
- Modify: `README.md` (lines 69–78, "Comment export" section)
- Modify: `docs/software-viability-usability-implementation-findings.md` (lines 5–45 status block)

- [ ] **Step 1: Update `README.md`** "Comment export" section to:

````markdown
## Comment export

`GET /api/sessions/:id/export` returns:

```json
{
  "branch": "HEAD",
  "baseRef": "main",
  "headSha": "…",
  "comments": [ { "id": "…", "nodeId": "…", "stableId": "…", "label": "…", "file": "…", "startLine": 1, "endLine": 20, "hunkSnippet": "…", "text": "…", "structuralContext": "…", "createdAt": 0 } ]
}
```

`comments` is an ordered array (insertion order); a node with multiple
comments has multiple entries, one per comment. `hunkSnippet` is derived by
the server when the comment is created (the bounded changed fragment shown
for the node, with real file line numbers); `structuralContext` is derived
at export time from the session's call/test edges. Both are server-owned —
`POST /api/sessions/:id/comments` accepts only `{ "nodeId": "…", "text": "…" }`.
````

- [ ] **Step 2: Update the findings doc status block.** In `docs/software-viability-usability-implementation-findings.md`, change line 5's status note to also mention P1 (`P0 items implemented 2026-07-14; remaining P1 items implemented 2026-07-15`), and inside the "Implementation status" section append to the **Resolved** list:

```markdown
- Exported comments lack hunk/structural context (High) — hunk snippets are
  server-derived at comment creation from the node's real diff lines;
  structural context is derived at export from stored call/test edges; the
  export envelope carries branch/baseRef/headSha and node line ranges.
- Structural exploration missing from the UI (High) — collapsible Relations
  panel under the diff (direction, file, changed/test/in-walk/review state)
  with breadcrumb detours and a "Return to review walk" action.
- Diff reconstruction loses source coordinates (Medium) — `NodeDiff` now
  carries hunk-accurate `DiffLine[]` (old/new file line numbers); the web
  diff renders them directly instead of re-diffing text blobs.
- Runtime API validation insufficient (Medium) — zod schemas on all mutating
  routes with structured `{ error, issues }` 400s; comment creation enforces
  node/session ownership.
```

  and update the **Still open** line to remove the four resolved items (leaving: entry-point provenance/confidence; residual bounding boxes; SCIP edge semantics; bulk mutations; error/loading/empty states; lint no-op; SSE cleanup).

- [ ] **Step 3: Commit**

```bash
git add README.md docs/software-viability-usability-implementation-findings.md
git commit -m "docs: mark P1 structural-value items implemented; update export contract"
```

---

### Task 7: End-to-end verification (build + real browser)

**Files:** none (verification only; fix regressions if found)

- [ ] **Step 1: Full suite + typecheck + build**

```bash
pnpm test && pnpm typecheck && pnpm build
```

Expected: all green; build copies `scip.proto` and produces `packages/web/dist`.

- [ ] **Step 2: Launch the built app against this repo** (the feature branch itself is the review target — dogfood):

```bash
SREV_DB_PATH=/tmp/srev-verify.db pnpm start &
sleep 3
curl -s -X POST localhost:3456/api/sessions -H 'Content-Type: application/json' -d '{"branch":"HEAD","baseRef":"main"}'
```

Expected: JSON with a session id (SCIP indexing may take ~30–60 s). Then `PUT` a small plan via `/plan` (one orphans unit with a changed stableId from the create response) so the walk order exists.

- [ ] **Step 3: Drive the UI with Playwright MCP** — navigate to `http://localhost:3456/?session=<id>` and verify, taking a screenshot of each:
  1. Diff pane shows the unified diff with two gutter columns whose numbers match the real file (spot-check one added line against the actual source line number).
  2. Relations panel lists callers/callees with chips; clicking one shows the breadcrumb bar; "⏎ Return to review walk" returns to the original node and hides the bar.
  3. Leave a comment, then `curl localhost:3456/api/sessions/<id>/export` and confirm `hunkSnippet` (with `+`/line numbers) and `structuralContext` are populated and the envelope has `branch`/`baseRef`/`headSha`.
- [ ] **Step 4: Kill the server, report results.** Any mismatch between gutter numbers and real file lines is a Task 1/2 bug — fix before declaring done.

---

## Self-review notes

- **Spec coverage:** finding "structural exploration" → Task 4 (direction, label+file, changed/test state, in-walk, reviewed, breadcrumb + return — all five bullet requirements covered); "diff coordinates" → Tasks 1–2 (exact `DiffLine` shape from the doc, unchanged nodes numbered from `startLine`); "comment context" stage 1 → Task 3 (server-derived, bounded snippet + export-time structural context; stage-2 line selection is explicitly deferred per the P1 scope); "runtime validation" → Task 5 (statuses, unit unions, nonempty labels/entries, duplicates, comment ownership + length, reorder positions via `position` int ≥ 0; branch/base-ref already validated).
- **Type consistency:** `DiffLine` is declared identically in `server/src/diff.ts` and `web/src/api/client.ts` (hand-mirrored per repo convention). `truncateWalkPath(index)` is the only new store API; `RelationsPanel` props match the `SplitLayout` call site; `formatHunkSnippet` marker/padding format matches the Task 3 unit test exactly (`marker + padStart(5) + space + text`).
- **Known intentional break:** export envelope changes from `{comments}` to `{branch, baseRef, headSha, comments}` — additive, `comments` key unchanged; `packages/skill` calls `GET /export` (orchestrate.ts:52-54) but reads only `.comments`, so the additive envelope is compatible (verified by final review).
