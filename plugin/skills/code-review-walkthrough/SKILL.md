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

Every `crw` command below is run as:

```bash
CRW_DATA_DIR="${CLAUDE_PLUGIN_DATA}" CRW_INDEXER_HOME="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/dist/crw.js" <command>
```

The env prefix is required on every invocation (state and indexers live in the
plugin data dir, never in the reviewed repo). Requires Node >= 22.13. Every
command prints JSON on stdout; add `--pretty` for human-readable output. Never
touch the SQLite file or hand-roll `curl` — the CLI is the stable surface.

```bash
crw serve [--repo <path>] [--port N]            # ensure the hub runs against a repo
crw session create --branch <b> --base <ref|empty> [--open]   # base "empty" = whole-repo review
crw context --session <id> [--brief|--full]     # planning view: commit subjects, flows + merge suggestions, orphan groups, change summaries (--brief: no stableIds, numeric refs only; --full: raw dump)
crw plan --session <id> (--auto | --units <file.json>) [--open]
crw diff --session <id> --node <stableId>       # one node's diff, for grouping decisions
crw status --session <id>                       # coverage, per-unit reviewed/total, unreviewed list
crw comments --session <id>                     # exported comments, GitHub-mappable
crw wait --session <id> [--until reviewed|commented] [--interval s] [--timeout s]
crw session list                                # sessions in this repo's hub, newest first
crw session delete --session <id>               # remove one session's state (cascades)
crw gc [--repo <path>] [--all]                  # remove a repo's DB/logs (stops the hub first); --all sweeps dead repos
crw shutdown                                    # stop the hub (state stays; serve restarts it)
```

Language support: TypeScript and Python indexers are installed automatically
(first session start runs `npm install` in the plugin data dir — allow a
minute once). Java additionally needs the scip-java toolchain on PATH
(coursier `cs` + JDK + Maven); without it Java changes appear as residual-only
with a visible warning — relay that warning, it is expected degradation, not
an error.

Setup flow:

1. `crw serve` — starts (or reuses) the hub for the current repo; prints `baseUrl`.
2. `crw session create --branch <b> --base <ref>` (`--base empty` reviews the
   entire repo) — prints `sessionId`, `uiUrl`,
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

- **flow-unit** — `{ "kind": "flow", "flowIds": [127], "label": "...", "rationale": "..." }`
  — reference flows by the numeric `id` the context printed. `"mergeGroup": 0`
  expands to that `mergeSuggestions` entry's whole flow set. Both resolve to
  entry stableIds at submit and combine with each other and with explicit
  `flowEntryStableIds: ["<entry>", ...]` (the singular `flowEntryStableId` is
  also still accepted) — prefer the numeric refs; never transcribe SCIP
  stableIds by hand. An unknown `flowId`/`mergeGroup` fails the submit loudly.
- **orphan-unit** — `{ "kind": "orphans", "orphanStableIds": ["..."], "orphanFiles": ["docs/**"], "label": "...", "rationale": "..." }`
  — `orphanFiles` globs (`**`, `*`, `?`) resolve to unassigned changes at
  submit; prefer them over long stableId lists. Wildcards match dotfiles
  (`dir/*` covers `dir/.env.example`). Either field alone is fine;
  overlapping matches go to the earliest unit; a glob-only unit that matches
  nothing fails the submit loudly.

Steps for an LLM-authored plan:

1. Gather the change's stated intent when available: `gh pr view --json
   title,body`. Commit subjects already arrive in `crw context` as
   `commitSubjects` — no separate `git log` step. This is intent input, not
   diff reading — the "never run `git diff`" rule below stands. No PR or
   uninformative messages → proceed without; never block on missing intent.
2. After `crw session create`, run `crw context --session <id> --brief`. It
   prints `{ sessionId, commitSubjects, flows, mergeSuggestions, orphanGroups, changes }`
   with **no stableIds anywhere**: `flows` are the **affected** flows as
   `{ id, name, entry, changedCount }` — reference them in the plan by that
   numeric `id`; `mergeSuggestions` precomputes the flow-merge guideline
   (next step) as `{ group, flowIds, names }`; `orphanGroups` are
   `{ dir, files }` — write `orphanFiles` globs from them; and `changes` is a
   compact per-node summary (file, lines, label, kind, status, +/- counts) —
   **not** diff bodies. That is everything a plan references. Without
   `--brief` the context carries full stableIds and per-pair merge evidence;
   `--full` restores the complete flat dump (all flows with steps) if you
   truly need it.
3. Make one flow-unit per **affected** flow, using `flowIds: [id]`. Do not
   split flows. **Merge** flows into one multi-entry flow-unit when they
   substantially review the same change. The guideline (shared changed
   nodes ≥ half of the smaller flow's changed set) is precomputed: write
   `"mergeGroup": <group>` to take a whole suggestion, or list the ids
   (`flowIds: [127, 142]`). Treat a suggestion as the default merge and spend
   your judgment on the label — name the shared capability, not the entry
   names (e.g. "Order validation — via API, CLI and worker"). Never merge
   flows with disjoint changed sets just to shorten the plan.
4. Group the remaining orphans into orphan-units by shared purpose (e.g.
   "validation helpers") — `orphanGroups`' directory clustering is usually
   most of the answer, and `orphanFiles` globs express it directly
   (`"orphanFiles": ["docs/**"]`). **Do not hand-author units for changed tests, DTOs,
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
8. Write the plan file (`{ "overview": "...", "units": [...] }`) and run
   `crw plan --session <id> --units plan.json`. It prints `coverage` and
   per-unit `attached` counts. `coverage.unassigned > 0` now means true
   leftovers (nothing could attach them) — the response lists each under
   `unassigned` (`stableId`, `label`, `file`; always present, `[]` at full
   coverage): add orphan-units for exactly those stableIds (or an
   `orphanFiles` glob that covers them) and re-submit.

**Never run `git diff` for planning.** If you must read a node's code to decide
grouping, use `crw diff --session <id> --node <stableId>` — it returns just that
one node's diff.
