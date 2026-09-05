# Helping humans judge a change

Status: product direction proposal, September 2026. The structural orientation
in the skill, review notes, keyboard help and freshness fixes exist today. The
views and review records described below are proposed additions.

## What the NestJS example reveals

A reviewer followed a junior developer's large NestJS change successfully, but
missed that it introduced a directory structure at odds with the expected
project conventions. The flow can look coherent even when the organization of
the code is a poor fit. A view that deliberately deemphasizes files removes
some of the visual evidence that would make that departure apparent.

Review involves several kinds of judgment: whether the change belongs in the
product, whether its design fits the system, whether its implementation works,
and whether the evidence is sufficient to ship it. A call walk primarily helps
with the third. None of these judgments implies the others.

Nest's documentation recommends feature modules that group related capabilities
and treats module exports as public interfaces. Its CLI also supports both
standard and monorepo project layouts. That supports inspecting feature cohesion,
module wiring and exported providers; it does not justify labeling every unusual
folder name a framework violation. A project's documented decisions and existing
healthy examples should guide the comparison. See [Nest modules](https://docs.nestjs.com/modules)
and [CLI project structure](https://docs.nestjs.com/cli/overview#project-structure).

## 1. Show the shape of the change before the walk

The highest-value addition would be a compact orientation page before the first
function diff. Show a before/after directory tree with additions, deletions and
moves; new dependencies; public entry points; and affected modules. Retain enough
unchanged neighboring structure to make the proposed placement understandable.

For the NestJS example, select a newly added feature and compare it beside an
established sibling feature. Show controllers, providers, DTOs and tests as they
are organized in each. Include the Nest module imports/exports and provider
registrations where available. Let the reviewer follow the evidence into files.

An agent can suggest a question such as “Existing features live under
src/features; this change adds controllers and services under src/engine. Is
that a deliberate new boundary?” Include the actual paths and the convention
being compared. Let the reviewer replace the comparison exemplar if it is stale
or inappropriate. A novel structure is a discussion trigger, not an error score.

This should be a complementary view of the same review, with stable selection
between structure, flow and file views. Don't create a second set of competing
progress counters or require people to navigate a large graph canvas.

## 2. Preserve review questions separately from traversal

Use a small set of change-specific questions to hold the review's intent. For
example: “Why is a new module boundary needed?”, “Who owns authorization on this
entry point?”, or “What demonstrates that existing callers still work?”

Each question should have evidence links, a human response, and a state such as
open, answered, deferred or not applicable. Keep the number small and editable.
Explicitly distinguish a documented requirement, a framework recommendation, an
inferred local convention, and the agent's suggestion. A percentage is not an
appropriate confidence display for these categories.

The reviewer could finish reading all changed items while leaving a design
question open. Show “all changes marked reviewed; two questions open,” and export
both. Don't silently promote a complete traversal to an approval recommendation.
Review notes already provide a place for these observations; structured questions
would make them harder to lose.

## 3. Make missing evidence visible

A diff contains what someone wrote. Many important findings concern what they
didn't write: input rejection, failure recovery, authorization, a migration,
compatibility, monitoring, or a test of a boundary condition.

For a changed public interface, connect the promised behavior to relevant tests,
test results and unanswered cases. Imported-by-test is only a relationship; it
doesn't establish what the test asserts. Let the reviewer open the assertion and
record whether it answers the question. Suggest a few risk-specific cases rather
than imposing the same exhaustive checklist on every review.

A useful later integration would let a reviewer run a selected existing test or
inspect a supplied execution trace and preserve the command, result and source
version. Execution needs an explicit action and clear provenance; static edges
must remain distinguishable from observed runtime behavior.

## 4. Let review units express intent

Whole call flows make a good initial walk but are sometimes too large or overlap
in unhelpful ways. Eventually units should claim changed items explicitly, with
flow relationships retained as navigation context. That permits splitting one
flow into meaningful concerns or grouping a migration with unrelated consumers.

Retain one canonical home per changed item, reference it from other units, and
show all unassigned items. Add merge, split and move operations the human can
perform directly. The planner's proposal should be easy to correct, without
asking an agent to regenerate an opaque plan.

## 5. Preserve the reviewed version across revisions

Immutable review snapshots and a revision comparison would be a larger technical
investment with substantial human value. Today the hub reads the working tree;
freshness warnings tell you to recreate the session after edits. They don't freeze
the displayed code or safely carry marks onto changed code.

A revision should bind source, base, diff, graph and comments to the same snapshot.
Re-review should highlight changes since the previous review, retain comment
history, and invalidate affected review marks. Changes to a dependency may require
reconsidering an unchanged caller, so carrying a mark forward based only on an
unchanged function hash would be insufficient.

## Order and evaluation

Start with the change-shape page, comparison to an existing feature, and the
ability to capture one unresolved design question. Validate that combination
before adding framework rule engines or more automatic findings. Snapshotting
is the next substantial foundation for safe long-running and repeated reviews.

Try the orientation page on several substantial changes: one with a structural
departure, one with a missing behavior, and one whose existing organization is a
good fit. Compare it with the current walk, rotating which view people see first.
Ask reviewers to explain the design and identify concerns before showing any
agent-generated assessment. Then introduce evidence-backed suggestions and see
whether those improve judgment or simply steer it.

Observe time to understand the change, findings with supporting evidence, false
alarms, context-switching and willingness to use it again. Completing more nodes
or agreeing more often with the agent is not, by itself, a successful outcome.
