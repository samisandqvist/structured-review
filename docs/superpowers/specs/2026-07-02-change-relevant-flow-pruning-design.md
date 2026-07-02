# Change-relevant flow pruning: trees follow the change, caps never eat it

Date: 2026-07-02
Status: proposed (awaiting review)

## Problem

`buildFlowTree` walks the full call tree from an entry with blind caps
(`MAX_TREE_DEPTH = 10`, `MAX_TREE_STEPS = 120`). Two consequences:

1. **Scaffolding dominates.** A flow-unit can be mostly unchanged chips
   between the entry and the actual change; the reviewer scans past them.
2. **Caps are by count, not relevance.** A changed node past step 120 (or
   depth 10) is truncated out of the tree. The coverage backstop then files it
   under "Unassigned changes" — technically covered, semantically misfiled:
   the node *is* on a flow, but the partition says it isn't.

## Design

### Relevance-guided walk (server, `flow-tree.ts`)

`buildFlowTree` gains an optional relevance set:

```
buildFlowTree(entry, callAdj, resolve, relevant?: Set<string>)
```

`relevant` = symbols from which a changed node is reachable, computed once per
`getFlows` call by reverse BFS from the changed set over the reversed call
adjacency (new pure helper `reachesChanged(changed, callAdj): Set<string>` in
`flow-tree.ts`).

Walk rules with `relevant` present:

- **Recurse only into relevant callees.** The spine of the tree is exactly
  entry → … → changed nodes.
- **Off-path callees are emitted but not descended into**: one step with a new
  flag `offPath: true`, giving one hop of context ("this path also calls X")
  without its subtree. This bounds the tree by the change's shape instead of a
  global count.
- Changed nodes themselves are always on-path (`offPath: false`), as is every
  ancestor on a path to one.
- `MAX_TREE_DEPTH` stays as a cycle/pathology guard; `MAX_TREE_STEPS` applies
  to **off-path steps only** — an on-path step is never dropped by a cap.
  Result: truncation cannot orphan a changed node.

Without `relevant` (no session context), behavior is unchanged — callers that
want the full tree still get it.

### Provider and route plumbing

`GraphProvider.getFlows` gains an optional parameter:
`getFlows(changedStableIds?: Set<string>)`.

- `routes/flows.ts` already loads the session's nodes; it passes the changed
  stableId set. The provider derives `relevant =
  reachesChanged(changedStableIds, callAdj)` from its own adjacency — the
  route never sees the graph.
- `ScipGraphProvider.getFlows` and CRG's `readFlows` thread `relevant` through
  to `buildFlowTree`.
- Flow **affectedness** in the route is unchanged (a flow is affected if a
  step is changed). An unaffected flow prunes to entry + one-hop off-path
  context, which still passes the provider's `steps.length > 1` filter when
  the entry has callees.
- `FlowStep` (server type, flows route response, `client.ts`) gains
  `offPath: boolean` (default false) and `stableId` if not already added by
  the multi-entry spec.

### Rendering (web, `PlanView.tsx` / `FlowTrack`)

- Consecutive `offPath` steps at the same position collapse into one expander
  row: `⋯ N unchanged calls` (dim, dashed). Clicking expands the run inline
  (client-side state; the steps are already in the response — no new
  endpoint).
- Expanded off-path chips render as today's `step--ext`/unchanged chips and
  are clickable when they carry a `nodeId` (context nodes), preserving
  "navigate into unchanged code to verify assumptions". Deeper exploration
  stays available via the node detail's `callers`/`callees`.

### Interaction with coverage

`unitCoverage` unions changed steps of the flow — the pruned tree retains
*more* changed nodes than today's capped tree (never fewer), so coverage only
improves. The "changed node truncated → misfiled as Unassigned" failure mode
disappears by construction.

## Edge cases

- **Entry itself is the only changed node:** spine = entry; its callees all
  render as one collapsed off-path run.
- **Cycle through a changed node:** ancestor guard unchanged; reverse BFS
  handles cycles (visited set).
- **Everything on the path is changed (dense diff):** no collapsing happens;
  behavior degrades gracefully to today's full tree.
- **Off-path cap hit:** only context chips are dropped; emit the collapsed
  count from actual data so "⋯ N unchanged calls" stays truthful (count what
  was walked, cap what is emitted; if capped, label "⋯ many unchanged calls").

## Testing

- `reachesChanged`: direct, transitive, cyclic, disconnected cases.
- `buildFlowTree` with `relevant`: on-path spine complete; off-path children
  emitted once, not descended; changed node at depth > cap still present;
  off-path steps beyond `MAX_TREE_STEPS` dropped without touching the spine.
- Flows route: `offPath` flags surface; affected computation unchanged.
- Web: collapsed run renders with correct count; expand/collapse works; a
  changed step never renders inside a collapsed run.
- Regression: fixture that previously truncated a changed node into
  "Unassigned changes" now shows it on its flow.

## Out of scope

- Server-side pagination/expansion endpoints for deep unchanged subtrees.
- Pruning of the **nodes list** or graph storage (session subgraph unchanged).
- Any change to orphan computation (`⋃ flow.steps` may only grow).
