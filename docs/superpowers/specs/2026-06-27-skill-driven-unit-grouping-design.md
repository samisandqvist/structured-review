# Skill-driven, coverage-guaranteed review plan

Date: 2026-06-27
Status: approved (design)

## Problem

The flows panel (`FlowsView`) can silently omit changes. Flows are built from
execution roots (`ScipGraphProvider.getFlows`), so a changed node that no flow
reaches — a changed type/constant, a function called only by tests, a node past
the depth/step caps in `buildFlowTree` — appears in zero flows. The UI counts
*flows* ("X affected / Y total"), not *changes*, so a reviewer working from the
left panel cannot tell whether every change is represented.

We want the left panel to become a **Claude-ordered review plan** with a
mechanically enforced coverage invariant:

> **Every changed node appears in at least one review unit.**

Units are not an arbitrary partition of nodes. A shared changed node (e.g. an
edited library helper) legitimately sits on multiple flows, so membership is
many-to-many and "at least one", not "exactly one".

## Units

A **unit** is one of two kinds:

- **flow-unit** — one affected flow, rendered exactly as today's `FlowTrack`.
  A flow-unit *is* one flow; Claude does not split or merge flows.
- **orphan-unit** — one or more changed nodes that no flow reaches (types,
  constants, test-only functions, depth-truncated nodes), grouped together.

Claude's job is **ordering + describing**, not partitioning: arrange the
affected flows and orphan groups into a sensible review sequence, group orphans
into orphan-units, and give each unit a short `label` and an optional
`rationale` that says **what the unit's functionality/purpose is** (not why it
was ordered there). `rationale` is optional and may be dropped if it can't be
generated well.

## Coverage universe and invariant

Universe = all session nodes with `changeStatus === "changed"` (includes changed
tests; excludes unchanged context nodes).

**Invariant:** every node in the universe appears in ≥1 unit. Satisfied by
construction — a changed node is either in some affected flow (→ that flow is a
unit) or it is an orphan (→ in an orphan-unit). The server backstops: any changed
node that ends up in no chosen unit is swept into an auto-created **"Unassigned
changes"** orphan-unit. A dropped flow therefore cannot silently lose a change.

## Architecture

Three layers: server (kind-tagged units, derived membership, coverage backstop +
reporting), skill (how Claude orders/describes), view (Plan panel). The old graph
view is removed.

---

### Layer 1 — Server

**Orphan set (the "first step").** The server computes, for a session, the
changed nodes that appear in no flow's steps:

```
orphans = { changed session node n | n.stableId ∉ ⋃ flow.steps.stableId }
```

This is exposed so both the skill and the Plan view can use it (added to the
`/:id/flows` response as an `orphans: Node[]` field, alongside the existing
`flows`).

**Unit model.** Drop the disjoint `nodes.unit_id` assignment entirely (it was
never populated). Units become kind-tagged; membership is derived per kind:

- `kind: "flow"` → `member_stable_ids = [flowEntryStableId]`; full membership is
  derived at read time via the flow (entry → `buildFlowTree`).
- `kind: "orphans"` → `member_stable_ids = [...orphan stableIds]`; these *are*
  the members.

Schema change to `units`: add `kind TEXT NOT NULL`, repurpose the JSON column to
`member_stable_ids` (stableIds, not db node ids). `entry_point_node_ids` is
removed. `nodes.unit_id`, `getNodesByUnit`, and the `/:id/nodes?unitId=` branch
are removed as dead (membership is derived/many-to-many now). `reviewed_in_unit`
stays (records the unit position a node was reviewed under).

**Plan API.**

```
PUT /api/sessions/:id/plan
{
  units: [
      { kind: "flow",    flowEntryStableId: string, label, rationale? }
    | { kind: "orphans", orphanStableIds: string[], label, rationale? }
  ]
}
```

On write the server:

1. Clears prior units.
2. Creates units in `position` order with `kind`, `member_stable_ids`, `label`,
   `rationale`.
3. **Coverage + backstop.** Resolve each unit's *changed* nodes:
   - flow-unit → resolve the flow by entry stableId, collect changed nodes among
     its steps;
   - orphan-unit → its `orphanStableIds` that are changed session nodes.
   Union = covered set. Any changed node not covered → appended to an
   auto-created `kind:"orphans"` unit **"Unassigned changes"** at the last
   position.

**Coverage reporting.** `GET /api/sessions/:id` gains:

```
coverage: { changedTotal: number, covered: number, unassigned: number }
```

`unassigned` = size of the auto "Unassigned changes" unit; `covered + unassigned
=== changedTotal` always.

**Kept:** `/:id/nodes` list, `/:id/nodes/:nodeId` (with `callers`/`callees`),
`getNodeNeighbors`, and the diff/comment/review-status flow.

---

### Layer 2 — Skill

The plan is produced by **Claude at skill-run time**, backstopped by the server.
Claude accesses the data through a **thin CLI wrapper** (`orchestrate.ts`) over
the existing HTTP server — the same endpoints the web UI uses, no second
implementation of "what's a flow / what's an orphan".

#### Data interface (CLI)

**`orchestrate plan-context --branch <b> --base <base>`** — creates the session
and prints one JSON bundle: `{ sessionId, flows, orphans, changes }`, where
`changes` is a **compact, software-computed change summary per changed node** —
*no raw diff text*. One record per changed node, bounded by node count, not diff
size:

```jsonc
{
  "stableId": "fn:validateOrder",
  "label": "validateOrder",
  "kind": "function",          // SCIP symbol kind: function|method|type|const|test|…
  "file": "src/orders.ts",
  "startLine": 35, "endLine": 50,
  "status": "modified",        // added | modified | deleted
  "added": 6, "removed": 2,    // changed lines overlapping this node's span
  "signature": "function validateOrder(o: Order): Result"  // declaration line only
}
```

Derivation, all deterministic and in software:
- `kind` from SCIP `SymbolInformation.kind` (surfaced onto the graph node; falls
  back to a name/`isTest` heuristic where SCIP gives none);
- `added`/`removed` by intersecting the file's changed hunks (`fileChangedRanges`
  in `diff.ts`) with the node's `[startLine, endLine]` span;
- `signature` = the node's declaration line (first line of its span).

A 500-line change to one function still emits one small record (`added: 500`,
signature, kind) — never the 500 lines.

**No raw diffs in planning context (rule).** The branch diff is for the human in
the web UI, not for planning. Claude builds the plan from `flows + orphans +
changes` alone. For the rare case it must read code to make a grouping call,
**`orchestrate diff --session <id> --node <stableId>`** returns just that one
node's diff slice (bounded) — never `git diff` over the branch. skill.md
instructs Claude to never run `git diff` itself for planning.

**`orchestrate submit-plan --session <id> --plan <plan.json>`** — validates the
ordered, kind-tagged units, `PUT`s them, and prints the returned `coverage`
report so Claude can self-correct.

#### skill.md guidance

`packages/skill/skill.md` gains a "Building the review plan" section instructing
Claude to:

- Run `plan-context` and read `flows + orphans + changes` (not diffs).
- Build an ordered list of units: every **affected flow** becomes a flow-unit;
  group the orphans into orphan-units by shared purpose (e.g. "type/contract
  changes", "test fixtures"), using `kind`/`file`/`signature` from the change
  summary. Do not split or merge flows.
- Give each unit a `label` and an optional short `rationale` describing the
  unit's purpose/functionality.
- Order units for a sensible review walk (e.g. foundational/orphan contract
  changes first, then the flows that depend on them — Claude's judgment).
- Pull a single node's diff via `orchestrate diff` only when a grouping decision
  genuinely needs the code; never run `git diff` over the branch.
- Run `submit-plan`; if the printed `coverage.unassigned > 0`, add orphan-units
  for the leftovers and re-submit.

**`orchestrate.ts` internals.** `UnitInput` becomes the kind-tagged shape;
`partitionFn` returns the ordered units. The CLI keeps a deterministic default
partition (used when run non-interactively): one flow-unit per affected flow
(criticality order) + a single "Other changes" orphan-unit holding all orphans —
safe because the server backstops coverage anyway. `createSession` / `writePlan`
/ `exportComments` seams are otherwise unchanged; `plan-context`, `diff`, and
`submit-plan` are thin commands over them plus the change-summary computation.

---

### Layer 3 — View

The left panel becomes the **Plan**: a single, ordered, Claude-built list of
units. The graph/flows toggle is removed; there is one view, named **Plan**.

- Units render in `position` order, each with its `label` and (if present)
  `rationale`, plus review progress (reviewed / changed within the unit).
- **flow-unit** renders as the current `FlowTrack` (steps as a left→right call
  tree; changed steps highlighted; clickable to the diff).
- **orphan-unit** renders as a labeled group of node chips (its changed nodes),
  each clickable to the diff.
- The **"Unassigned changes"** unit gets a warning treatment so a gap is
  impossible to miss.
- A changed node shared across units shows its review state everywhere: review it
  once and it reads as already-reviewed when revisited in another unit (per-node
  `review_status`; `reviewed_in_unit` records where) — the "reused function shown
  as reviewed, revisit deliberately" behavior from the original idea doc.
- Status bar: a coverage chip — `N units · Y/Y changes` — that turns
  warning-colored when "Unassigned changes" is non-empty. Replaces the
  `units[0].label` field shown in `App.tsx:71-75`.

**Removed (graph view and its code):**

- `packages/web/src/components/GraphView.tsx`
- `packages/web/src/components/FrontierStrip.tsx` (already unimported / dead)
- `ViewToggle` and the `viewMode` branch in `App.tsx`
- `viewMode` / `setViewMode` / `ViewMode` from `store/ui.ts`
- The `viewMode` conditional in `SplitLayout.tsx` (render the Plan view directly)
- npm deps used only by GraphView: `@xyflow/react`, `@dagrejs/dagre`
- The graph-oriented copy in `SplitLayout`'s `EmptyState` (rewritten for the
  Plan walk)

**Kept:** `NodeBadge.tsx` (used by `DiffView`), the diff panel, comment box,
mark-reviewed flow, and split-pane resize.

---

## Data flow (end to end)

1. Skill run → `createSession` → server builds change subgraph, stores changed +
   context nodes.
2. Claude runs `plan-context`, reads `flows + orphans + changes` (compact
   summary, no diffs), and builds an ordered plan (flow-units + orphan-units,
   each labeled/described) → `submit-plan`.
3. `PUT /plan` → server stores units, computes coverage, sweeps any uncovered
   changed node into "Unassigned changes".
4. Plan view reads `units` (+ flows for flow-units, member stableIds for
   orphan-units) and renders the ordered walk.
5. Reviewer walks each unit; marks nodes reviewed (state shared across units that
   contain the same node); comments export as before.

## Error handling / edge cases

- **Skill lists a non-existent / non-changed stableId in an orphan-unit:** ignored
  (no matching changed session node); logged.
- **Skill drops an affected flow that uniquely contained a changed node:** that
  node is uncovered → swept into "Unassigned changes"; coverage chip flags it.
- **Shared changed node on two flows:** appears in both flow-units (intended).
- **No flows at all (provider built none):** every changed node is an orphan;
  the plan is all orphan-units. The Plan view never depends on flows existing.
- **Empty session (no changes):** Plan shows an empty state; coverage chip `0/0`.

## Testing

- **Server (vitest):** orphan-set computation (changed node in no flow → orphan;
  changed node on a flow → not); plan write stores kind-tagged units; coverage
  union over flow-units + orphan-units; uncovered changed node → swept into
  "Unassigned changes"; `covered + unassigned === changedTotal`; shared node
  counted as covered when any containing unit is present; changed tests in the
  universe, unchanged context nodes not.
- **Skill (vitest):** change-summary computation (per-node `added`/`removed` from
  hunk∩span; `kind`/`signature`; `status`); `plan-context` bundle shape;
  `orchestrate` default plan returns kind-tagged units (one flow-unit per
  affected flow + an orphan-unit); round-trips through `submit-plan`; post-write
  coverage reports zero unassigned for a fully-covered fixture. `plan-context`
  never emits raw diff bodies.
- **Web:** Plan renders units in order; flow-units as tracks, orphan-units as
  chip groups; shared node shows reviewed state across units; "Unassigned
  changes" gets warning treatment; coverage chip reflects `coverage`. App builds
  with GraphView and its deps removed (no dangling imports).

## Out of scope

- Showing unaffected flows in the plan (reachable via the diff panel only).
- Pruning the now-possibly-unused `edges` array from the `/nodes` list response.
- Message-passing / queue-based flows.
- Changing how the subgraph or flows are computed (SCIP provider untouched).
- Comment export format (unchanged).
