# Skill-driven, coverage-guaranteed unit grouping

Date: 2026-06-27
Status: approved (design)

## Problem

The flows panel (`FlowsView`) can silently omit changes. Flows are built from
execution roots (`ScipGraphProvider.getFlows`), so a changed node that no flow
reaches — a changed type/constant, a function called only by tests, a node past
the depth/step caps in `buildFlowTree` — appears in zero flows. The UI counts
*flows* ("X affected / Y total"), not *changes*, so a reviewer working from the
left panel cannot tell whether every change is represented.

We want a stronger, mechanically enforced invariant:

> **Every changed node belongs to exactly one review unit.**

Units are Claude's *semantic* grouping ("a unit = a correct commit"), produced at
skill-run time. Flows are demoted to supporting *evidence* shown inside a unit.
Coverage is guaranteed by the server, so no LLM mistake can drop a change.

## Coverage universe

The set we guarantee coverage over = all session nodes with
`changeStatus === "changed"` (this includes changed tests — a changed test is a
change worth reviewing). Unchanged context nodes (callers/callees pulled in for
orientation) do **not** require a unit.

## Architecture

Three layers: server (storable/total/disjoint partition + coverage reporting),
skill (how Claude partitions), view (left panel grouped by unit). The old
graph view is removed.

---

### Layer 1 — Server

**Make `nodes.unit_id` real.** The column and index already exist
(`schema.ts:23,53`) but nothing writes them. Today the plan endpoint
(`routes/sessions.ts:91-104`) only stores `entry_point_node_ids` on units.

**Plan API change.** Each unit gains an explicit membership list:

```
PUT /api/sessions/:id/plan
{
  units: [
    {
      label: string,
      rationale: string,
      memberStableIds: string[],          // NEW: full set of changed nodes in this unit
      entryPointNodeIds?: string[]         // optional "start here" anchor (subset)
    }
  ]
}
```

`memberStableIds` carries the partition. `entryPointNodeIds` stays optional for
the "where to start" anchor. *(Alternative considered: derive membership from
flow reachability rather than an explicit list. Rejected — orphans have no flow
to derive from, which is exactly the case we must cover.)*

On write the server:

1. Clears prior units and resets `unit_id` to NULL on all session nodes.
2. Creates units in `position` order. For each `memberStableId`, resolves the
   session node and sets its `unit_id`. **Disjointness is structural** — `unit_id`
   is a single column, so the first unit listing a node wins; a node listed by a
   later unit is ignored (logged, not an error).
3. **Totality reconciliation.** After assignment, any node with
   `changeStatus = "changed"` and `unit_id IS NULL` is swept into an
   auto-created unit **"Unassigned changes"** at the last position. This is the
   orphan bucket promoted to a real unit — coverage is guaranteed by the server,
   not by trusting Claude.

**Coverage reporting.** `GET /api/sessions/:id` gains:

```
coverage: { changedTotal: number, assigned: number, unassigned: number }
```

where `unassigned` = count of changed nodes that landed in the auto
"Unassigned changes" unit (i.e. what the skill failed to place deliberately).
With reconciliation in place, `assigned + unassigned === changedTotal` always.

**Unit membership exposure.** Units already round-trip via
`GET /api/sessions/:id` (`units`). The Plan view needs, per unit, its member
nodes and their change/review status. The existing `/:id/nodes?unitId=` route
(`routes/nodes.ts:13-14`) already supports filtering by `unit_id`; once
`unit_id` is populated it works as-is. The `id`-vs-`stableId` mapping for
`memberStableIds` is resolved server-side at plan-write time (same pattern as
edges in `sessions.ts:72-79`).

**No server graph-view teardown.** The `/:id/nodes` list+edges and
`/:id/nodes/:nodeId` (with `callers`/`callees` via `getNodeNeighbors`) endpoints
stay: they feed the diff panel and status counts. Edges in the list response may
become unused client-side after the graph view is removed, but the endpoint is
left intact (out of scope to prune).

---

### Layer 2 — Skill

The partition is produced by **Claude at skill-run time** (structure proposes,
intent decides), backstopped by the server's reconciliation. skill.md
(`packages/skill/skill.md`) gains a "Partitioning for total coverage" section
instructing Claude to:

- Fetch the change subgraph **plus flows and coverage** (orchestrate exposes all
  three).
- Assign **every changed node** to exactly one unit. A unit = "a correct commit"
  — independently valuable, logically whole.
- Place orphans (changes no flow reaches — types, constants, test-only fns,
  depth-truncated nodes) **with the unit they support**, or in their own unit if
  genuinely standalone. Do not leave them for the auto-unit unless truly
  miscellaneous.
- Record, per unit, the flows passing through its changed nodes (evidence).
- After writing the plan, **check `coverage.unassigned`**. If `> 0`, inspect the
  "Unassigned changes" unit and reassign deliberately.

**`orchestrate.ts` changes.** The `partitionFn` contract changes to return units
with `memberStableIds`. The CLI `main()` keeps a *deterministic default*
partition so the script is safe without Claude in the loop: group changed nodes
by the flow/entry that reaches them; leftovers fall through to the server's
auto-unit. Real intelligence is Claude editing/driving the partition. The
`createSession` / `writePlan` / `exportComments` seams are unchanged except for
the `UnitInput` shape gaining `memberStableIds`.

---

### Layer 3 — View

The left panel is **grouped by unit**. The graph/flows toggle is removed; there
is a single view, named **Plan**.

- Top level = units (collapsible). Each shows: label, rationale, changed-node
  count, and review progress (reviewed / total within the unit).
- Inside a unit: the flows passing through its changed nodes (the existing
  `FlowTrack` rendering, reused as evidence), plus a small **"not in any flow"**
  sub-list for that unit's orphan changes — each clickable to load its diff, like
  any flow step.
- The **"Unassigned changes"** unit renders with a warning treatment so a gap is
  impossible to miss.
- Status bar: a coverage chip — `N units · Y/Y changes` — that turns
  warning-colored when the "Unassigned changes" unit is non-empty. (Replaces the
  per-unit `units[0].label` field currently shown in `App.tsx:71-75`.)

**Removed (graph view and its code):**

- `packages/web/src/components/GraphView.tsx`
- `packages/web/src/components/FrontierStrip.tsx` (already unimported / dead)
- `ViewToggle` and the `viewMode` branch in `App.tsx`
- `viewMode` / `setViewMode` / `ViewMode` from `store/ui.ts`
- The `viewMode` conditional in `SplitLayout.tsx` (render the Plan view directly)
- npm deps used only by GraphView: `@xyflow/react`, `@dagrejs/dagre`
- The graph-oriented copy in `SplitLayout`'s `EmptyState` (rewritten for the
  Plan walk)

**Kept:**

- `NodeBadge.tsx` (used by `DiffView`)
- Diff panel, comment box, mark-reviewed flow — unchanged
- The split-pane resize behavior

---

## Data flow (end to end)

1. Skill run → `createSession` → server builds change subgraph, stores changed +
   context nodes (`unit_id` NULL).
2. Claude partitions changed nodes → `PUT /plan` with `memberStableIds` per unit.
3. Server assigns `unit_id`, sweeps stragglers into "Unassigned changes",
   computes coverage.
4. Plan view reads `units` + per-unit nodes + flows; renders unit groups with
   flows-as-evidence and per-unit orphan sub-lists.
5. Reviewer walks each unit; marks nodes reviewed; comments export as before.

## Error handling / edge cases

- **Skill lists a non-existent or non-changed stableId:** ignored at plan-write
  (no matching changed session node); logged.
- **Skill lists a node in two units:** first unit wins (single `unit_id` column).
- **Skill assigns nothing / partial:** server reconciliation guarantees totality
  via the auto-unit; coverage chip flags it.
- **No flows at all (provider built none):** units still render; every unit's
  changes show in its "not in any flow" sub-list. The Plan view never depends on
  flows existing.
- **Empty session (no changes):** Plan view shows an empty state; coverage chip
  shows `0/0`.

## Testing

- **Server (vitest):** plan write assigns `unit_id`; duplicate stableId →
  first-wins; unplaced changed node → swept into "Unassigned changes";
  `coverage` math (`assigned + unassigned === changedTotal`); changed tests are
  in the universe; unchanged context nodes are not.
- **Skill (vitest):** `orchestrate` default partition returns
  `memberStableIds`; round-trips through `writePlan`; after write, coverage
  reports zero unassigned for a fully-covered fixture.
- **Web:** Plan view groups nodes by unit; orphan sub-list shows changes not in
  any flow; "Unassigned changes" unit gets warning treatment; coverage chip
  reflects `coverage`. Confirm the app builds with GraphView and its deps
  removed (no dangling imports).

## Out of scope

- Pruning the now-possibly-unused `edges` array from the `/nodes` list response.
- Message-passing / queue-based flows.
- Changing how the subgraph or flows are computed (SCIP provider untouched).
- Comment export format (unchanged).
