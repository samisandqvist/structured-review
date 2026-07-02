# Multi-entry flow-units: merge flows that review the same change

Date: 2026-07-02
Status: proposed (awaiting review)

## Problem

Flow = entry-point call tree is a structural partition; a reviewable unit is *a
coherent change to one capability*. They diverge under **fan-in**: one feature
touched from three entry points (HTTP route + CLI command + background job all
calling the same changed core) becomes three flow-units that each re-walk
mostly the same changed nodes. Shared review state softens the cost but the
reviewer still sees three units that are morally one.

The current "Claude must not split or merge flows" rule removes the tool that
would fix this. Merging can be allowed **without giving up derivable
membership**: a flow-unit with multiple entries is just the union of the
per-entry trees. (Splitting stays forbidden — it breaks derivability; see Out
of scope.)

## Design

### Unit model (server)

`kind: "flow"` units accept multiple entries. `member_stable_ids` for a
flow-unit becomes the list of entry stableIds (today it is a 1-element list —
the storage shape does not change, only the cardinality).

**Plan API** (`PUT /api/sessions/:id/plan`): `PlanUnitInput` gains
`flowEntryStableIds?: string[]`. The singular `flowEntryStableId` remains
accepted and is normalized to a 1-element array on write (the skill's older
plans and the deterministic default partition keep working; `UnitInput` in
`orchestrate.ts` and `web/src/api/client.ts` mirror the change).

**Coverage** (`coverage.ts`): `unitCoverage` for a flow-unit resolves *each*
entry to its flow and unions the changed step stableIds. An entry that matches
no flow contributes nothing (same behavior as today's single-entry miss).

### Overlap signal for the skill

Claude must be able to decide merges from the plan context alone — no code
reading. The `/:id/flows` response (and therefore `plan-context`) gains, per
flow:

```
changedStableIds: string[]   // stableIds of this flow's changed steps
```

Computed in `routes/flows.ts` where steps are already joined against session
nodes — no new queries.

### skill.md guidance

Replace "Do not split or merge flows" with:

- Do not split flows.
- **Merge** flows into one multi-entry flow-unit when they substantially
  review the same change — guideline: shared changed nodes ≥ half of the
  smaller flow's `changedStableIds` (Jaccard-style overlap on
  `changedStableIds`). Label the merged unit by the shared capability, not by
  the entry names ("Order validation — via API, CLI and worker").
- Never merge flows with disjoint changed sets just to shorten the plan.

The deterministic default partition in `orchestrate.ts` stays one-flow-per-unit
(safe; server backstop unchanged).

### Plan view (web)

A flow-unit renders one `FlowTrack` per resolved entry, stacked inside the one
unit block, each track prefixed by a small entry caption (the flow's `name`).

**Progress must dedupe.** The current counter counts a flow's changed steps;
with multiple tracks a shared changed node would be double-counted. `FlowStep`
in the flows route response (and `client.ts`) gains `stableId`, and the unit
progress in `PlanView.tsx` becomes: distinct changed `stableId`s across the
unit's tracks, reviewed = distinct changed stableIds whose status ≠
unreviewed. (This also fixes the latent double-count *within* one track, where
a shared callee appears under several callers.)

## Edge cases

- **Duplicate entry listed twice in one unit:** dedupe on write.
- **Same entry in two different units:** allowed (many-to-many membership is
  already the model); review state is shared via the node, as today.
- **Entry resolves to no flow:** unit still renders its other tracks; the
  missing entry contributes no members; coverage backstop catches any node
  that thereby went uncovered.
- **All entries unresolvable:** unit renders as an empty flow-unit with a
  "no flow resolved" hint (today's single-entry behavior, made visible).

## Testing

- `unitCoverage`: multi-entry union; overlapping flows counted once;
  unresolvable entry contributes nothing.
- Plan write: singular `flowEntryStableId` normalized; duplicates deduped.
- Flows route: `changedStableIds` matches changed steps; `stableId` present on
  steps.
- Web: multi-entry unit renders N tracks under one header; progress counts
  distinct changed stableIds once; reviewed state reflects across tracks.
- Skill fixture: two flows with high changed-overlap → guidance example merges
  them; `submit-plan` round-trips and coverage reports zero unassigned.

## Out of scope

- **Splitting flows** (sub-flow units). Membership would no longer be derivable
  from an entry; revisit only with real-session evidence of fan-out pain.
- Automatic (software-side) merging — the overlap guideline stays Claude's
  judgment; the server never merges.
- Changing flow computation or entry detection.
