<!-- packages/skill/skill.md -->
---
name: code-review-walkthrough
description: Walk a reviewer through code changes along the call/dependency graph instead of a file tree. Produces a structured review plan, launches a local web UI for graph-based navigation, and exports node- and line-anchored comments.
---

# Code Review Walkthrough

## What this skill does

Given a git branch or diff range, this skill:

1. Ensures the local review hub is running (`crw serve`)
2. Creates a review session from the change subgraph (`crw session create`)
3. Builds the review plan — mechanical (`crw plan --auto`) or LLM-authored (`crw plan --units`)
4. Launches the web UI for the reviewer to walk the graph
5. Harvests the reviewer's output (`crw status`, `crw comments`) for wrap-up

## When to use

Use this when reviewing code changes — especially large, AI-generated changes
where file-tree review doesn't map to the code's actual structure.

## The crw CLI

All orchestration goes through `crw` (built binary: `packages/skill/dist/cli.js`;
dev: `npx tsx packages/skill/src/cli.ts`). Every command prints JSON on stdout;
add `--pretty` for human-readable output. Never touch the SQLite file or hand-roll
`curl` — the CLI is the stable surface.

```bash
crw serve [--repo <path>] [--port N]            # ensure the hub runs against a repo
crw session create --branch <b> --base <ref> [--open]
crw context --session <id>                      # flows + orphans + change summaries for planning
crw plan --session <id> (--auto | --units <file.json>) [--open]
crw diff --session <id> --node <stableId>       # one node's diff, for grouping decisions
crw status --session <id>                       # coverage, per-unit reviewed/total, unreviewed list
crw comments --session <id>                     # exported comments, GitHub-mappable
crw wait --session <id> [--until reviewed|commented] [--interval s] [--timeout s]
crw session list                                # sessions in this repo's hub, newest first
crw session delete --session <id>               # remove one session's state (cascades)
crw gc [--repo <path>] [--all]                  # remove a repo's DB/logs (stops the hub first); --all sweeps dead repos
```

Setup flow:

1. `crw serve` — starts (or reuses) the hub for the current repo; prints `baseUrl`.
2. `crw session create --branch <b> --base <ref>` — prints `sessionId`, `uiUrl`,
   node/flow counts, and `indexWarnings`. **Always relay `indexWarnings` to the
   user** — they mean a language was indexed in degraded mode.
3. Build the plan (next section), then share `uiUrl` with the reviewer (or pass
   `--open`).

Harvest flow (after the reviewer walks the plan):

- `crw status --session <id>` — check progress; `stale: true` means the working
  tree moved under the session.
- `crw wait --session <id>` — block until every changed node is reviewed
  (exit code 2 on timeout).
- `crw comments --session <id>` — each `scope: "node"` comment carries node
  label, file, line anchor (`anchor.startLine/startSide/endLine/endSide`), hunk
  snippet, and the node's review status — ready to map onto GitHub PR inline
  comments. `scope: "session"` comments are review-wide remarks (no node, no
  anchor) — map those onto the PR review body.

## Building the review plan

`crw plan --auto` is the mechanical baseline: one flow-unit per affected flow;
tests, DTOs and module-scope leftovers attach themselves to those units at
submit, and anything truly homeless is swept into the auto "Unassigned changes"
unit. Prefer an LLM-authored plan when the change warrants judgment. The plan
is an optional session **overview** plus an ordered list of **units**,
each either a **flow** or an **orphan group**. The plan file is
`{ "overview": "...", "units": [...] }` (a bare units array is also accepted):

- **flow-unit** — `{ "kind": "flow", "flowEntryStableIds": ["<entry>", ...], "label": "...", "rationale": "..." }`
  (the singular `flowEntryStableId` is still accepted)
- **orphan-unit** — `{ "kind": "orphans", "orphanStableIds": ["..."], "label": "...", "rationale": "..." }`

Steps for an LLM-authored plan:

1. Gather the change's stated intent when available: `gh pr view --json
   title,body` and `git log <base>..<branch> --format=%s` (commit subjects
   only). This is intent input, not diff reading — the "never run `git diff`"
   rule below stands. No PR or uninformative messages → proceed without;
   never block on missing intent.
2. After `crw session create`, run `crw context --session <id>`. It prints
   `{ sessionId, flows, orphans, changes }`. `changes` is a compact per-node
   summary (kind, file, lines, +/- counts, signature) — **not** diff bodies.
3. Make one flow-unit per **affected** flow, using `flowEntryStableIds: [entryStableId]`.
   Do not split flows. **Merge** flows into one multi-entry flow-unit
   (`flowEntryStableIds: [e1, e2, ...]`) when they substantially review the same
   change — guideline: shared `changedStableIds` ≥ half of the smaller flow's
   changed set. Label a merged unit by the shared capability, not the entry names
   (e.g. "Order validation — via API, CLI and worker"). Never merge flows with
   disjoint changed sets just to shorten the plan.
4. Group the remaining orphans into orphan-units by shared purpose (e.g.
   "validation helpers"). **Do not hand-author units for changed tests, DTOs,
   or module-scope leftovers of files already in flows** — at plan submit the
   server nests those under the covered node that gives them context
   (tested-by / required-by / same-file), and they count toward that unit's
   coverage. Non-code-graph changes with no such home (configs, dependency
   manifests) still deserve explicit orphan-units, ordered early: they are the
   foundations the flows sit on.
5. Write a session `overview` (2–4 sentences, after the units are decided):
   what the change sets out to do — from stated intent when present, otherwise
   from what the diff observably does — and how the plan decomposes it
   ("units 1–2 are the config foundation, units 3–5 the consumer flows").
   State relation, never verdicts ("implements the issuance half of the token
   change", not "correctly issues tokens").
6. Give each unit a `label` and an optional short `rationale` (1–2 sentences)
   stating **what part of the overall change this unit carries**, in relation
   to the overview — not a restatement of what the code does. When a unit does
   not serve the stated intent, say so descriptively ("not part of the stated
   goal; appears to be a drive-by refactor of the retry helper") — that
   wording is the scope-creep signal; there is no separate divergence pass.
7. Order units for a sensible walk (foundational/helper changes first, then the
   flows that depend on them — your judgment).
8. Write the units array to a JSON file and run
   `crw plan --session <id> --units plan.json`. It prints `coverage` and
   per-unit `attached` counts. `coverage.unassigned > 0` now means true
   leftovers (nothing could attach them): add orphan-units for those and
   re-submit.

**Never run `git diff` for planning.** If you must read a node's code to decide
grouping, use `crw diff --session <id> --node <stableId>` — it returns just that
one node's diff.
