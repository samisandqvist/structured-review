# Line-Specific Commenting — Design

**Status:** approved 2026-07-16 (brainstormed with Sami; "line ranges" and
"changed lines only" chosen explicitly). Next: writing-plans → SDD.

**Goal:** a comment can be anchored to a range of changed diff lines inside a
node, selected in the diff pane, validated server-side, and carried through
export in a GitHub-mappable shape. Node-level comments (no anchor) keep
working exactly as today.

## Decisions (fixed)

- **Granularity:** line ranges. A single-line comment is a range with
  `start == end`.
- **Anchorable lines:** changed lines only (`added` / `removed`). Context
  lines are not selectable and cannot be endpoints. A range's *interior* may
  span context rows (endpoints changed, rows between included).
- **Anchor model (approach A, GitHub-shaped):**
  `{ startLine, startSide, endLine, endSide }`, side ∈ `"old" | "new"`.
  Removed lines anchor by `oldLine` on side `"old"`; added lines by
  `newLine` on side `"new"`. Range order is defined by **row position in the
  rendered diff** (the `DiffLine[]` the server itself generates), so a range
  may start on a removed line and end on an added one — mirroring GitHub's
  `start_line`/`start_side`/`line`/`side` review-comment params.
- **Anchor is all-or-nothing optional.** Absent anchor = node-level comment,
  byte-for-byte today's behavior.
- **No content-relocation, no display-row anchors** (rejected approaches B/C:
  row indexes are meaningless outside one render; content relocation is
  redundant with the session staleness fingerprint).

## Data model

One new nullable column on `comments`: `anchor TEXT` holding JSON
`{"startLine":n,"startSide":"old"|"new","endLine":n,"endSide":"old"|"new"}`,
`NULL` = node-level. (The design discussion said "four nullable columns";
implementation follows the `residual_ranges` precedent of a single JSON TEXT
column — one `ALTER`, same semantics, nothing queries by line.)

Migration: `SCHEMA_VERSION` 3 → 4, `MIGRATIONS[4] = ALTER TABLE comments ADD
COLUMN anchor TEXT;` (`db/schema.ts` — the existing versioned-migration
system; fresh DBs run 1→4).

Types (`packages/server/src/types.ts`):

```ts
export type AnchorSide = "old" | "new";
export interface CommentAnchor {
  startLine: number;
  startSide: AnchorSide;
  endLine: number;
  endSide: AnchorSide;
}
// Comment and ExportedComment gain: anchor?: CommentAnchor
```

## API + validation (`routes/comments.ts`, `validate.ts`)

`commentCreateSchema` gains optional `anchor` (zod object, all four fields
required when present; lines positive ints; sides enum). On POST with an
anchor:

1. Regenerate the node's diff exactly as the diff pane sees it:
   `getNodeDiffForRanges(...)` when the node has `residualRanges`, else
   `getNodeDiff(...)` — same inputs as `routes/nodes.ts` uses today.
2. Resolve each endpoint to a row index in `diff.lines`: side `"new"` matches
   a line with `type === "added" && newLine === anchor.…Line`; side `"old"`
   matches `type === "removed" && oldLine === …`. **Both endpoints must
   resolve** (i.e. be changed lines currently in this node's diff) and
   `startRowIdx <= endRowIdx`.
3. Failure → `400 { error: <specific message> }`. No clamping, no silent
   node-level fallback.
4. `hunkSnippet` becomes range-scoped for anchored comments:
   `formatHunkSnippet(diff.lines.slice(startRowIdx, endRowIdx + 1))` —
   existing bounds (40 lines / 2000 chars) still apply. Node-level comments
   keep the whole-node snippet.

`createComment` (repo) takes the optional anchor and persists it as JSON;
`rowToComment` parses it back. Export (`exportComments`) carries `anchor`
verbatim on each comment that has one — combined with the already-exported
`file`, this maps 1:1 to GitHub's review-comment params; no GitHub-specific
fields are added server-side.

## UI (`DiffView.tsx`, `CommentBox.tsx`, walk store)

- **Selection:** rows with `type !== "context"` get `cursor: pointer` and a
  hover affordance; click selects a single line, shift-click extends to a
  range (ordered by row index), clicking the same single selected line clears.
  Context and gap rows are inert. Selection state (`{startIdx, endIdx}` over
  the current diff's rows, plus the derived anchor) lives with the current
  node selection in the store and resets whenever the selected node changes.
- **Highlight:** selected rows get a left accent bar + tinted background.
- **CommentBox:** when a selection is active, show a chip
  `commenting on <file-side> lines X–Y` with a ✕ to clear; submit passes the
  anchor with the mutation; on success the selection clears. No selection ⇒
  today's node-level behavior, no visual change.
- **Existing anchored comments:** render a small `L X–Y` prefix chip;
  clicking the chip re-applies the highlight to the anchored rows if they
  resolve in the current diff (silently no-op if not, e.g. stale session).
- Leaving any comment still flips the node to `reviewed-commented`
  (unchanged).

## Out of scope

- GitHub API posting itself (the export consumer's job).
- Re-anchoring across working-tree drift (session staleness already covers
  drift detection).
- Anchors on context lines, multi-node ranges, threads/replies.

## Testing

- **validate:** anchor schema — accepts full anchor, rejects partial ones and
  bad sides/lines.
- **routes:** anchored create round-trips with range-scoped snippet; 400 on
  context-line endpoint, out-of-diff line, inverted range; node-level create
  unchanged; export includes `anchor`; anchored create against a node with
  `residualRanges` validates against the residual diff.
- **repo/schema:** v3→v4 migration adds the column; anchor JSON persists and
  parses; null anchor round-trips.
- **web (component tests):** click/shift-click selection behavior, chip
  render + clear, mutation payload includes anchor, selection resets on node
  change.
