# Diff-complete coverage: residual changes become reviewable nodes

Date: 2026-07-02
Status: proposed (awaiting review)

## Problem

The coverage invariant ("every changed node appears in ≥1 unit") is over
**nodes**, but the diff is over **lines** — and the node universe under-covers
the diff. A node only exists if SCIP extraction produced one, and
`buildGraphFromIndex` requires a body span and explicitly skips types/namespaces
(`packages/server/src/graph/scip.ts`, the `/[#/]$/` filter). So the following
changes are invisible to the invariant today:

- A changed `interface` / type alias / enum — no node, not in the changed
  universe. The coverage chip reads `N/N` while the type change is unreviewable.
- Module-scope statements and **import changes** in a file that has nodes —
  the hunks overlap no node span.
- **Files SCIP doesn't index at all**: `package.json`, configs, SQL migrations,
  CSS, JSON fixtures, markdown. For AI-generated PRs these are exactly the
  changes a reviewer must see (dependency bumps, config edits).

The unit-grouping design doc names "a changed type/constant" as a thing
orphan-units exist to catch — but extraction drops it before the invariant ever
sees it. The invariant should hold over the **diff**, not the node universe:

> **Every changed line appears in at least one review unit.**

## Design

### Residual computation (server, session creation)

Provider-agnostic, in `createSessionsRoute`'s POST handler after
`reconcileSubgraph`:

1. List changed files: new helper `changedFiles(baseRef, root): string[]` in
   `diff.ts` (`git diff --name-only <baseRef>`).
2. Per changed file, compute residual ranges:
   `residual(file) = fileChangedRanges(baseRef, file) − ⋃ span(node) for stored
   session nodes in that file` (interval subtraction; new pure helper
   `subtractRanges(ranges, spans): LineRange[]` in `diff.ts`).
3. For each file with a non-empty residual, store **one pseudo-node**:
   - `stableId: "file-residual:<path>"`
   - `label: "<basename> (module scope)"` for files that have real nodes;
     `label: "<basename>"` for files with no nodes at all (whole file is
     residual)
   - `startLine/endLine`: bounding box `[min(residual.start), max(residual.end)]`
   - `changeStatus: "changed"`, `reviewStatus: "unreviewed"`,
     `isTest: isTestFile(path)` (move/share the `isTestFile` helper from
     `scip.ts` into a common module)

No schema change: pseudo-nodes are ordinary `nodes` rows. They participate in
everything downstream for free:

- **Orphan set** — no flow step ever references `file-residual:*`, so they land
  in `orphans` on `/:id/flows` and reach the skill's `plan-context` bundle.
- **Coverage** — they are changed session nodes, so `computeCoverage` counts
  them; an unplanned residual is swept into "Unassigned changes" like any
  other changed node.
- **Diff view** — `getNodeDiff` clips the file's unified diff to the node span;
  works unmodified.

### One pseudo-node per file (trade-off, explicit)

The bounding-box span may enclose real nodes that sit *between* two residual
ranges (e.g. imports changed at the top, a constant at the bottom, a changed
function in the middle). The pseudo-node's diff then re-shows that function's
hunks. This duplication is accepted for v1: it is correct (never hides
anything), cheap, and the shared-review-state model already embraces seeing a
change in more than one place. Splitting into one pseudo-node per residual
range is rejected — import blocks alone would spray chips.

### Change summary (`/:id/changes`)

Pseudo-nodes get `kind: "file"` in the change-summary record (extend the
heuristic in `routes/changes.ts`; update its honesty comment). `signature` =
first non-blank residual line. `added`/`removed` computed as today from
hunk∩span.

### Skill guidance

`skill.md` orphan-grouping guidance gains one line: group `kind: "file"`
changes into orphan-units by purpose (e.g. "dependency & config changes",
"type/contract edits"), typically ordered first — they are the foundations the
flows sit on.

## Edge cases

- **Deleted file:** `git diff --unified=0` emits `+0,0`; `fileChangedRanges`
  yields `{start: 0, end: 0}`. Pseudo-node span `[0, 0]`; `extractHunkDiff`
  attributes all removed lines to new line 0, so the diff shows full old text
  vs empty — correct rendering. Label gets a `(deleted)` suffix.
- **Binary file:** `--text` forces a textual diff; if the result is
  unreadable noise, the reviewer still sees *that* the file changed, which is
  the point. No special handling in v1.
- **Renamed file:** appears as delete + add under plain `git diff`; two
  pseudo-nodes. Acceptable.
- **File whose only change is inside node spans:** residual is empty → no
  pseudo-node (no noise added for the common case).
- **`fileChangedRanges` returns `null`** (git errored): skip the file, log.
  Same failure mode as today's node reconciliation.

## Testing

- `subtractRanges` pure-function cases: disjoint, contained, overlapping,
  multi-span subtraction, empty result.
- Session with a type-only change → pseudo-node created, counted in
  `coverage.changedTotal`, appears in `orphans`.
- `package.json`-only change → pseudo-node for a file with no graph nodes.
- Import-line change in a file with changed functions → residual excludes the
  function spans.
- Deleted file → `[0,0]` span node, diff renders old text vs empty.
- E2E: coverage chip counts residual nodes; unplanned residual lands in
  "Unassigned changes" with warning treatment.

## Out of scope

- Splitting residuals into multiple pseudo-nodes per file.
- Treating type definitions as first-class graph nodes with reference edges
  (future provider work; this spec only guarantees they are *seen*).
- Rename detection (`git diff -M`).
