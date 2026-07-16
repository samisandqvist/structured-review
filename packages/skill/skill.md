<!-- packages/skill/skill.md -->
---
name: code-review-walkthrough
description: Walk a reviewer through code changes along the call/dependency graph instead of a file tree. Produces a structured review plan, launches a local web UI for graph-based navigation, and exports node- and line-anchored comments.
---

# Code Review Walkthrough

## What this skill does

Given a git branch or diff range, this skill:

1. Creates a review session by asking the local review server for the change subgraph
2. Runs the hybrid partitioner (structure proposes, intent decides) to produce review units
3. Writes the plan to the server
4. Launches the web UI for the reviewer to walk the graph
5. Exports structured, node-anchored comments when the review is complete

## When to use

Use this when reviewing code changes — especially large, AI-generated changes
where file-tree review doesn't map to the code's actual structure.

## How to orchestrate

The orchestration CLI provides three subcommands:

```bash
npx tsx packages/skill/src/orchestrate.ts plan-context --branch <b> --base <base>
npx tsx packages/skill/src/orchestrate.ts submit-plan --session <id> --plan plan.json
npx tsx packages/skill/src/orchestrate.ts diff --session <id> --node <stableId>
```

- `plan-context` — fetch the change subgraph and return session metadata
- `submit-plan` — write the plan to the server and get coverage summary
- `diff` — retrieve a single node's diff for reading before grouping

## Building the review plan

The plan is an ordered list of **units**, each either a **flow** or an **orphan group**:

- **flow-unit** — `{ "kind": "flow", "flowEntryStableIds": ["<entry>", ...], "label": "...", "rationale": "..." }`
  (the singular `flowEntryStableId` is still accepted)
- **orphan-unit** — `{ "kind": "orphans", "orphanStableIds": ["..."], "label": "...", "rationale": "..." }`

Steps:

1. Run `npx tsx packages/skill/src/orchestrate.ts plan-context --branch <b> --base <base>`.
   It prints `{ sessionId, flows, orphans, changes }`. `changes` is a compact per-node
   summary (kind, file, lines, +/- counts, signature) — **not** diff bodies.
2. Make one flow-unit per **affected** flow (`flows[].affected === true`), using
   `flowEntryStableIds: [entryStableId]`. Do not split flows. **Merge** flows into one
   multi-entry flow-unit (`flowEntryStableIds: [e1, e2, ...]`) when they substantially
   review the same change — guideline: shared `changedStableIds` ≥ half of the smaller
   flow's changed set. Label a merged unit by the shared capability, not the entry names
   (e.g. "Order validation — via API, CLI and worker"). Never merge flows with disjoint
   changed sets just to shorten the plan.
3. Group the `orphans` into orphan-units by shared purpose (e.g. "validation helpers",
   "test fixtures"), using each change's `kind`/`file`/`signature` from `changes`.
   Changes with `kind: "file"` are module-scope / non-code-graph changes (types,
   imports, configs, dependency manifests) — group them by purpose (e.g. "dependency
   & config changes", "type/contract edits") and order them early: they are the
   foundations the flows sit on.
4. Give each unit a `label` and an optional short `rationale` describing **what the unit
   does** (its functionality/purpose) — not why you ordered it.
5. Order units for a sensible walk (foundational/helper changes first, then the flows that
   depend on them — your judgment).
6. Write the units array to a JSON file and run
   `npx tsx packages/skill/src/orchestrate.ts submit-plan --session <sessionId> --plan plan.json`.
   It prints `coverage`. If `coverage.unassigned > 0`, add orphan-units for the leftovers
   (they were swept into the auto "Unassigned changes" unit) and re-submit.

**Never run `git diff` for planning.** If you must read a node's code to decide grouping,
run `npx tsx packages/skill/src/orchestrate.ts diff --session <sessionId> --node <stableId>`
— it returns just that one node's diff.
