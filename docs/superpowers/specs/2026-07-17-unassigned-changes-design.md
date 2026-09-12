# Unassigned changes — attach tests, DTOs and residuals to their context

Date: 2026-07-17. Status: approved design (brainstorm with Sami).
Origin: polyglot provider roadmap, "Unassigned-changes revisit" (2026-07-16
Phase 4 dogfood: 74/100 changes landed in "Unassigned changes"; most had
obvious homes).

## Problem

Three groups of changed nodes land in the auto "Unassigned changes" unit even
though the session already knows their context:

1. **Changed tests** — flows exclude tests by design (test callers are
   TESTED_BY evidence, not flow steps), so changed tests are always unassigned
   today, even when the code they exercise sits in a flow unit. The TESTED_BY
   edges are already persisted in the session's edges table.
2. **Uncalled types/DTOs** — changed nodes or residuals with no call edges
   (`DirectSqlRequestDto` etc.). The SCIP decoder currently drops type
   definitions as nodes and drops ROLE_IMPORT occurrences, so nothing links a
   DTO to its consumers.
3. **Module-scope residuals** of files whose methods ARE in flows
   (`IntrospectionService.java (module scope)`) — same-file affinity needs no
   new data.

## Decisions (settled in brainstorm)

- **Assigned = full walk membership.** Attached items are real walk steps,
  reviewed inside the unit's walk, and count toward unit coverage.
  "Unassigned changes" shrinks to true leftovers.
- **Single ledger.** Unit `reviewed/total` includes attached items; a unit is
  done when everything nested in it is reviewed. The `tests n/m` chip stays
  informational.
- **Cross-unit tests: first unit wins, references elsewhere.** A test
  exercising changed nodes in several units nests (counts, walks) under its
  first exercised node in plan/walk order; other units render a non-counting
  reference entry ("also tests this") that links to the test node.
- **Ordering: right after the parent node.** Walk goes production node → its
  attached items → next flow step.
- **Scope: all three groups**, including the decoder work for required-by.
- **Server-derived, always on.** Nesting is a function of the plan + graph,
  computed when the plan is written (PUT /plan). The plan schema is unchanged;
  `--auto` and LLM-authored plans benefit identically; re-submitting a plan
  re-derives.

## Approach

Persist attachments on units at plan-write time (approach A). Units are
already deleted/recreated on every plan write, so attachment lifecycle matches
unit lifecycle. Derive-on-read (B) was rejected: three consumers (web walk
order, PlanView, CLI status) would have to independently agree, reads become
provider-backed, and a mid-review reindex could silently reshuffle
attachments. A separate attachments table (C) is more machinery than a JSON
column on rows that live and die with the plan.

## Data model

Schema v6: `units` gains an `attached` JSON column.

```ts
interface AttachedMember {
  stableId: string;        // the attached changed node (test, DTO node/residual, module-scope residual)
  parentStableId: string;  // covered node it nests under
  reason: "tested-by" | "required-by" | "same-file";
  counted: boolean;        // false = cross-unit reference entry (render-only)
}
// Unit gains: attached: AttachedMember[]
```

Counted entries are real members (walk + ledger). `counted: false` entries are
the cross-unit test references: rendered dimmed with a jump link, no checkbox,
never in walk order, never in coverage.

## Derivation (server, inside PUT /sessions/:id/plan)

Input: the plan's units, session nodes, session TESTED_BY edges, flows (for
walk positions), and the provider's file-requires map. After
`computeCoverage`, each unassigned changed node goes through three passes;
first match wins; a parent must be a covered (assigned) node:

1. **tested-by** — the node is a test with a TESTED_BY edge from ≥1 covered
   node → attach under the first exercised covered node in overall walk order.
   Exercised covered nodes in *other* units yield `counted: false` references
   under their own units.
2. **same-file** — the node (typically a module-scope residual) lives in a
   file that has covered nodes → attach under the first same-file covered node
   in walk order.
3. **required-by** — the node lives in file B, and some covered node's file
   requires B (see decoder work) → attach under the first such consumer node
   in walk order.

4. **test imports** (fast-follow, same day) — a test node with no resolvable
   TESTED_BY edge (vitest `it()` bodies are anonymous callbacks, so calls
   inside them attribute to no graph node) attaches under the first covered
   node its *file* imports (requires map, reversed direction). Reason stays
   `tested-by` — to the reviewer it is the same relationship. Tests only:
   the reversed direction is too weak evidence for production code. To feed
   this, the requires map covers every non-local definition (functions,
   methods), not just type symbols.

Parents are always plan-covered nodes, never other attachments — no chaining
(a DTO required only by an attached test stays unassigned). Explicit plan
membership wins: a test or DTO listed in an orphan-unit is covered, so the
passes never touch it. Nodes no pass catches stay in the auto "Unassigned
changes" unit. Coverage:
attached counted nodes count as covered (computeCoverage extension), so
`coverage.unassigned` means true leftovers.

Determinism: "first … in walk order" uses the same ordering as
`buildWalkOrder` (units by position; flow steps in tree order; orphan members
in listed order).

## Decoder work (scip.ts)

Type definitions stay excluded as graph nodes. New: collect a file-level
requires map while building the graph:

- Type-definition occurrences (symbols ending `#`) record `typeSymbol →
  definingFile`.
- Any cross-file occurrence of such a symbol — including ROLE_IMPORT
  occurrences, currently dropped — records `consumerFile requires
  definingFile`.

Exposed as `GraphProvider.getFileRequires?(): Map<string, Set<string>>`
(optional; CRG and stub return empty, so pass 3 simply finds nothing and the
feature degrades to passes 1+2).

## Walk order and progress

- Web `buildWalkOrder`: after pushing a parent step/member, push its counted
  attachments (changed nodes only, first occurrence wins as today).
- Web PlanView `unitProgress` and CLI `status.ts unitProgress`: totals include
  counted attachments. Both read the persisted `attached` field — no
  recomputation, no drift.
- `srev plan` output gains per-unit attached counts; `srev status` picks the new
  totals up automatically.

## UI

Attached items render as indented sub-steps under their parent in the unit's
track — tests keep the existing green styling; required-by/same-file get a
neutral badge with the reason. References render dimmed with a jump link and
no checkbox. The diff pane is unchanged (attached nodes are ordinary session
nodes).

## Skill guidance

skill.md planning steps update: stop hand-authoring orphan-units for changed
tests, DTOs and module-scope residuals — they attach automatically to
whatever units the plan defines. Orphan-units remain for genuinely
free-standing changes. `coverage.unassigned > 0` after submit now means true
leftovers worth an explicit orphan-unit (or a plan gap).

## Testing

- Derivation unit tests: each pass on fixture sessions; precedence
  (tested-by > same-file > required-by); cross-unit test asserting
  first-unit-wins + reference entries; nothing-matches → stays unassigned;
  parent must be covered.
- Coverage arithmetic: attached counted nodes covered; references not.
- Walk order (web) and unitProgress (web + CLI): expansion right after parent,
  ledger includes attached, references excluded.
- Route test: PUT /plan persists `attached`; re-submit re-derives; schema v6
  migration test.
- Decoder: requires-map assertions on the existing TS/Python/Java fixtures
  (e.g. a DTO-like type referenced across files).

## Out of scope

- Reviewer-controlled attachment overrides (pin/exclude) — revisit if
  derivation misattaches in practice.
- Type symbols as first-class graph nodes.
- `srev context` surfacing attachability hints to the planner.
