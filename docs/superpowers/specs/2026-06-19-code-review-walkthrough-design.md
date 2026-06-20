# Code Review Walkthrough — Design

**Status:** Design with stack selected — ready for implementation planning
**Date:** 2026-06-19
**Source idea:** `code-review-workflow-idea.md`

## Problem

AI agents now write most of the code, so reviews are large and commit boundaries
rarely map to reviewable units. Squashed commits bundle several logical changes;
small commits may carry a bugfix for an earlier commit or a helper whose
correctness can't be judged without seeing its use. The deeper issue: conventional
review tools present changes as a **file tree**, and file structure is not the real
structure of what the code does.

This tool lets a reviewer **walk the code along its actual structure** — the call /
dependency graph — rather than down a file list.

## Scope

The tool's job **ends at emitting well-structured review comments.** Applying fixes,
re-reviewing them, and reconciling is an **external** concern (a separate Claude Code
run consumes the emitted comments). The system has exactly two contracts with the
outside world:

- **Plan in** — given a branch/diff, produce and persist a review plan.
- **Comments out** — after the walk, emit structured, durable comments.

In scope (v1): the planner, the call-graph navigation surface, review-state tracking,
node-anchored comment capture, and comment emission.

Explicitly out of scope (v1): the apply-fix / re-review loop; message-flow edge
extraction (named extension point only); nested units.

## Core principles

1. **Navigate by code structure, not file structure.** Files are explicitly *not*
   the thing you look at.
2. **A unit is "a correct commit"** — independently valuable, logically whole, would
   stand alone as a sensible PR. This is the testable target the planner aims at.
3. **The graph is typed edges over one navigation engine.** node = unit of code,
   edge = "triggers / depends-on". Call edges are one provider; message-flow is
   another, later. The walkthrough machinery is edge-type-agnostic.
4. **Node-atomic review.** The node is the unit of both review *status* and comment
   *anchoring*. A felt need for finer (per-hunk) granularity is a *partitioning
   smell*, not a missing feature.

## 1. Review plan (partitioning)

A plan splits the change under review into **ordered units, each reviewed
separately**. A unit = a "correct commit" (see principle 2). Well-scoped work yields
a single unit; the planner does not split artificially.

**Hybrid generation — structure proposes, intent decides:**

- **Structure proposes:** candidate clusters are derived from the change subgraph,
  anchored on **entry points** (REST endpoints, externally-triggered top-level
  functions) and grouped by the **domain entity / concern** they touch (e.g. group
  `POST /orders` + `GET /orders` because both concern `Order`; keep `/auth/*`
  separate).
- **Intent decides:** the LLM reads the diff + candidate clusters and
  merges/splits/labels them by purpose. **Every unit carries a one-line rationale**
  ("grouped because all three implement request caching") plus the structural
  evidence behind it.

**Reviewable plan.** Before the walk begins, the reviewer can edit the plan —
merge, split, or move a node between units. The rationale makes a boundary
rejectable on its merits.

**Units are flat in v1.** Nesting (drilling a large unit into entrypoint-rooted
sub-units, with reviewed-state rolling up) is a documented **future extension**, not
built in v1.

## 2. Navigation

**Surface — adjustable split.** A single layout with a draggable divider between the
**call-graph map** and the **side-by-side diff**. The split ratio is the
graph-complexity adapter: drag toward the diff and the graph becomes a rail (good for
small graphs); drag toward the graph and the diff becomes a thin drawer that slides
to the current node (good for complex graphs). A **frontier/agenda strip** runs along
the bottom.

**Guided walk + free override.** The default experience is "walk me through": the tool
suggests the next node and you advance. At any point you can break off — click a
neighbor, dive into unchanged code, go up to callers — then resume.

**"Next" = a suggested step from a visible frontier.** The *frontier* is the set of
in-scope, unreviewed nodes reachable from the current position, and it is **always
visible as an agenda**. "Next" picks one (a DFS-shaped default, matching how people
trace a call chain), but because the whole frontier is on screen and jumpable, the
DFS-vs-BFS question dissolves — the reviewer is never trapped in the tool's choice.

**Top-down is the walk; bottom-up is a local move.**

- *Top-down* (default, primary): seed from the unit's entry points and descend toward
  callees. Entry points give natural, non-scattered starting seeds.
- *Bottom-up* is **not** a global re-seed (that would start from a scattered spray of
  changed leaves). It is a **local affordance** available at any node — "show callers
  / jump to usages" — used to judge a helper by how it is used, then return to the
  walk.

**Into unchanged code.** The reviewer can navigate into unchanged callers/callees to
verify that assumptions about the code being called still hold. Unchanged nodes are
context, rendered distinctly from changed nodes.

**Graph rendering — neighborhood by default, overview on demand.**

- **Focused neighborhood** is the working view: the current node and its ±1-hop
  callers (above) and callees (below), plus a breadcrumb spine of the path taken. It
  re-centers as you move and stays legible at any unit size, because the full graph is
  never drawn at once. The neighborhood *is* the visible frontier.
- A collapsible **overview** (corner mini-map) shows the whole unit graph for
  orientation and can pop out into a full layered DAG when the reviewer wants the big
  picture, then collapse back.

Node rendering states (color/style): current · reviewed · frontier (pending) ·
unchanged/context.

## 3. Review state & comments

**Node-atomic.** The node is the atomic unit of review. A changed function's multiple
hunks are shown together (visually separated) and reviewed as one node. If a node
*feels* like it wants per-hunk accept buttons, that signals the unit was partitioned
wrong — surfaced as plan feedback, not solved with finer UI granularity.

**Node states:**

- **unreviewed** — in scope, not yet looked at.
- **reviewed-clean** — looked at, accepted, no comment.
- **reviewed-commented** — looked at, ≥1 comment left.
- **reviewed-elsewhere** — carried in from an earlier unit (see below).
- **unchanged/context** — navigated into to verify an assumption; not part of the
  diff.

**"Reviewed" is first-class state, independent of comments.** A node can be
reviewed-clean with no comment. The review-session state (in the review server) is the
source of truth and persists across the pass.

**Node reuse vs. split change.** A node can resurface in a later unit for two reasons,
and they are handled differently:

1. **Reuse (the common, desired case):** the same node, with the *same
   already-reviewed change* (or unchanged), pulled in because the later unit's new code
   calls it. → badged **"✓ reviewed in Unit N"** and skipped by default; revisited only
   deliberately.
2. **Split change (the smell case):** the node genuinely changed for two different
   logical reasons that the planner couldn't keep together, so it appears in two units
   with *different hunks*. → the reviewer still reviews the new-to-this-unit hunks,
   **and** the tool flags the split as a possible weakness in the plan.

Good partitioning maximizes case 1 and minimizes case 2; surfacing case 2 honestly is
part of the design.

**Comments are node-anchored.** A comment is *authored* on a concrete diff hunk but
*stored* against the enclosing node's stable identity (CRG resolves line → enclosing
node). This survives reformatting and line drift — important precisely because the fix
loop happens externally and the reviewer returns later. Each stored comment carries:

- the node id (primary anchor),
- the original hunk / snippet (secondary hint, preserves authoring intent),
- structural context (callers/callees) for free, so the external agent can act well.

No edge anchoring: a "wrong-argument-at-the-callsite" remark is simply a comment on
the **caller node** — the edge is implicit in which node you're standing on.

## 4. The graph: typed edges over one engine

The navigation engine never cares what *kind* of edge connects two nodes:

- **Call/dependency edges — provider #1 (v1).** Supplied by CRG (tree-sitter →
  call/dependency graph in SQLite, with blast-radius / risk). Entry point = an uncalled
  top-level function; callee = what it calls.
- **Message-flow edges — provider #2 (future).** "Producer sends `OrderPlaced`" →
  "these handlers consume `OrderPlaced`" is structurally identical to caller→callee.
  Entry point = a message producer; "callee" = a handler. Same frontier, reviewed-state,
  neighborhood view, and top-down walk apply unchanged. A *named extension point*, not
  built in v1.

## 5. Architecture

Four built components plus two external edges (input, fix loop):

```
① Git branch / diff range          (input — external)
        │
        ▼
② Claude Code skill / plugin  ── the LLM half
   • asks ③ for the change subgraph
   • runs the hybrid partitioner → review plan (units + rationale)
   • writes plan into ④;  launches ⑤;  afterward reads comments back out
        │  plan in  /  comments out  ▲
        ▼                            │
④ Local review server  ── the hub
   • owns review-session state: plan · per-node reviewed status · node-anchored
     comments  (SQLite)
   • pulls graph/edges/blast-radius from ③, diffs from git
   • serves the web UI; UI talks ONLY to ④
        ▲ graph                      │ serves
        │                            ▼
③ CRG engine                   ⑤ Web UI — the adjustable split layout
   tree-sitter call graph,        graph map (neighborhood + overview) ·
   blast-radius; typed-edge       side-by-side diff · frontier agenda ·
   provider #1 (calls)            comment box; top-down walk; mark reviewed
        │
        ▼
⑥ External fix loop  (OUT OF SCOPE — separate Claude Code run consumes comments)
```

**Boundary decisions:**

- The **review server (④) is the single hub.** The web UI never reads CRG or git
  directly — it goes through ④, which keeps the UI's backend singular and the CRG
  dependency encapsulated.
- CRG sits **behind the hub** as the graph/edge provider, consistent with the typed-edge
  model (additional edge providers plug in at the same boundary).
- The skill (②) and the server (④) are **separate**: the skill is the LLM/planning
  process and the orchestrator; the server is the stateful backend the UI depends on.

**Prior art to build on** (from the source idea's research):

- **CRG (code-review-graph)** — the graph engine; get it and use it as edge provider #1
  rather than building the graph layer from scratch.
- **claude-reviewer** (Ben Bowles) — read for inspiration on the local web UI and the
  comment-capture loop.

## Defaults (fillable, low-controversy)

- **Input:** default to a git **branch / diff range vs `main`**; support a
  "whole-codebase" mode for non-PR reviews.
- **Comments-out format:** structured **JSON keyed by node id**, each comment carrying
  rationale / original hunk / structural context, plus a reviewed-state summary for the
  pass.

## Novel parts (vs. prior art)

The pieces exist separately; nothing combines them. The genuinely new parts this design
commits to:

- the **code-structure graph as the actual review navigation surface** (not a file tree);
- **top-down as the primary walk with bottom-up as a local move**, avoiding the
  scattered-start problem;
- **marking already-reviewed code within a pass** and badging reuse across units;
- the **typed-edge model** that makes message-passing / queue review a future provider
  on the same engine.

## Stack

**Deployment model:** strictly local single-user. localhost only, no auth, SQLite on
disk. One reviewer at a time, launched alongside Claude Code. Hosting / team use is a
future concern, not designed for in v1.

**Runtime & package manager:** Node.js, pnpm workspaces monorepo.

**Monorepo layout:**

```
packages/
  skill/     # Claude Code skill + superpowers glue (LLM half)
  server/    # Local review hub — Hono + better-sqlite3
  web/       # Vite + React UI
```

**Server (`packages/server`):**

- Hono — HTTP API + SSE for live review-state updates to the UI.
- `better-sqlite3` — sync SQLite for review-session state (plan, node status,
  comments). One `.db` file per project, stored alongside the repo.
- Serves the built `packages/web` output as static files in prod; Vite dev server
  proxies the API in dev.
- Graph provider boundary: a `GraphProvider` interface; CRG is implementation #1
  (over MCP stdio or HTTP, whichever CRG exposes).

**Web (`packages/web`):**

- Vite + React 19 + TypeScript.
- TanStack Query — server state (plan, nodes, comments, review status), cache
  invalidation on mutations.
- Zustand — UI-only state (draggable split ratio, current node, walk path, overview
  open/closed).
- React Flow — graph neighborhood rendering + mini-map overview. Pan/zoom, node
  states (current / reviewed / frontier / unchanged), edge rendering come built-in.
- `react-diff-viewer-continued` — side-by-side diff rendering; no need to build.

**Skill (`packages/skill`):**

- Claude Code skill markdown + orchestration scripts (TypeScript, run via Node).
- Talks to the server over HTTP (localhost); orchestrates: ask server for the change
  subgraph → run hybrid partitioner (LLM) → write plan → launch UI → read comments
  back out.

**Testing:** Vitest across all packages. Playwright for web UI E2E when the navigation
surface needs it.

**Dev / build:** `pnpm dev` starts server + Vite concurrently. `pnpm build` produces
the static UI served by the hub.

## Future extensions (named, not built in v1)

- Nested units (drill a large unit into entrypoint-rooted sub-units; reviewed-state
  rolls up).
- Message-flow edge provider (#2) for queue / message-passing systems.
