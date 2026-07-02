# Review-walk DX: fluent navigation, editable plan, test visibility, staleness

Date: 2026-07-02
Status: proposed (awaiting review)

## Problem

The review loop is high-repetition and currently mouse-only with no positional
memory. Concretely: finding the next thing to review means visually scanning
chips across units for un-highlighted ones; a multi-sitting review restarts
from nothing; a 300-line node with a 2-line change opens scrolled to the top;
completed units keep occupying screen; the plan order/labels are Claude's guess
and cannot be corrected; "did the tests change with the behavior?" requires
leaving the tool; and a review that outlives its commits silently shows stale
diffs.

Seven independent improvements, one spec — they share the same surfaces
(`PlanView`, `SplitLayout`, `store/ui.ts`) and none changes the data model
beyond one column and one small route.

## Design

### 1. Walk order + "next unreviewed" (the spine of the rest)

A single client-side selector `useWalkOrder(sessionId)` (new
`web/src/walk-order.ts`) derives the canonical review sequence from data the
Plan view already fetches: units sorted by `position`; within a flow-unit, its
flow steps in tree order; within an orphan-unit, `memberStableIds` order;
keep only steps/nodes that are `changed` and carry a `nodeId`; dedupe by
`nodeId` keeping first occurrence.

- **Next unreviewed** = first entry after the current node (wrapping) whose
  `reviewStatus === "unreviewed"`. Exposed as a primary button in the diff
  footer ("Next unreviewed →") and keyboard `n`. When none remain, the button
  reads "All changes reviewed".
- **Next / previous** (`j` / `k`) step through the sequence regardless of
  review state.

### 2. Keyboard map

Global listener (in `SplitLayout`), inert while focus is in an input/textarea:

| key | action |
|---|---|
| `j` / `k` | next / previous change in walk order |
| `n` | next unreviewed change |
| `r` | mark current node reviewed-clean (and advance to next unreviewed) |
| `c` | focus the comment box |
| `?` | toggle a small shortcut overlay |

`r` advancing is the core loop: read → `r` → read → `r`.

### 3. Persisted position

`useUIStore` gains `zustand/middleware` `persist` to `localStorage`, keyed by
session (`crw-ui:<sessionId>`), persisting `currentNodeId` and `splitRatio`
plus the unit-collapse state from §4. Reopening the UI mid-review lands on the
node you left. (Server stays stateless about UI position.)

### 4. Unit collapse + "mark remaining reviewed"

- Each unit header gets a collapse toggle; collapse state persisted (§3). A
  unit whose changed nodes are all reviewed auto-collapses (manual expand
  always wins over auto).
- Unit header overflow menu gets **"Mark remaining reviewed"**: PATCHes every
  unreviewed changed member to `reviewed-clean` (existing
  `updateNodeStatus`), behind a one-click confirm ("Mark 7 nodes reviewed?").
  For trivial units (renames, generated code) this is the difference between
  the tool respecting or wasting the reviewer's time.

### 5. Editable plan (reorder + rename)

Claude's ordering is a guess; the reviewer knows their intent.

- **Server:** `PATCH /api/sessions/:id/units/:unitId` accepting
  `{ label?: string, position?: number }`. Position change reindexes the
  session's units (splice semantics). No coverage recomputation needed —
  membership is untouched.
- **Web:** drag handle on the unit header (HTML drag-and-drop, no new dep);
  double-click the label to rename inline. `rationale` stays read-only.
- The auto "Unassigned changes" unit is neither renamable nor reorderable.

### 6. Per-unit test chip

Answers "did tests move with this change?" per unit, from data already in the
client: `getNodes` returns `edges` including `edgeType: "test"` (source =
production node, target = test node). For each unit, over its member
production nodes: collect linked test nodes; chip renders
`tests <changed>/<total>` (e.g. `tests 2/5`), warning-tinted when `total > 0 &&
changed === 0` — behavior changed but no test did. Units with no linked tests
show nothing (absence of signal ≠ warning; test discovery is graph-dependent).
Clicking the chip selects the first linked test node in the diff pane.

### 7. Stale-session indicator

- **Schema:** `review_sessions` gains `head_sha TEXT NOT NULL DEFAULT ''`,
  filled at session creation (`git rev-parse HEAD` via a new helper in
  `diff.ts`).
- **Server:** `GET /api/sessions/:id` compares stored `head_sha` to current
  HEAD and adds `stale: boolean` to the response.
- **Web:** when stale, the status bar shows a warning chip
  `repo moved since session start` (same visual family as the coverage
  warning). Purely informational in v1 — the apply-fix/re-review loop stays
  out of scope; this just prevents *silently* reviewing stale diffs.

## Edge cases

- Walk order with zero changed nodes → nav buttons disabled, no keybinding
  effects.
- Node reachable from two units → appears once in walk order (first
  occurrence); `r` in one unit flips its chips everywhere (existing shared
  state).
- Persisted `currentNodeId` no longer exists (new session data under same id
  is impossible — ids are random — but a deleted node isn't): selector falls
  back to null → empty state.
- Reorder race (two PATCHes): last write wins; positions reindexed server-side
  keep the sequence dense.
- `git rev-parse` fails (repo gone): `stale` omitted, no chip — degrade
  silently, matching existing git-error handling in `diff.ts`.

## Testing

- `useWalkOrder` (unit): ordering across unit kinds, dedupe, wrap-around,
  next-unreviewed with mixed statuses.
- Keyboard: `r` advances; keys inert while comment box focused.
- Persistence: store rehydrates position and collapse state per session key.
- Server: unit PATCH renames, reindexes positions, rejects the auto unit
  (400); session GET reports `stale` correctly (fixture repo, move HEAD).
- Test chip: counts from `test` edges; warning state when tests untouched;
  hidden when no linked tests.
- E2E (Playwright): full loop — open session, `n` to first unreviewed, `r`
  through a unit, unit auto-collapses, "mark remaining" clears another unit,
  drag-reorder persists after reload.

## Out of scope

- Multi-reviewer presence/state.
- Server-persisted UI position.
- Apply-fix / re-review loop and any auto-refresh of a stale session
  (indicator only).
- Custom keybinding configuration.
