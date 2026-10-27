# Reviewing a change on the component map

Status: implemented on the feature branch. Builds on the
[component map](2026-10-26-component-map-design.md) and on the review model in
[review model](../../review-model.md).

## Intent

A structured review walks a change along its call flows. That answers "in what
order do I read this?" It does not answer "where in the system does this change
land, and which contracts does it touch?" For a change spread over several
components, the second question is often the one a reviewer cannot answer from
the diff alone.

The component map answers it. This design offers the map as a second structure
for the same review: the reviewer sees the change marked on the map at every
level, drills down to a changed component, and reviews its changed items there
with the same diff view, comments and review marks as in the walk. The flow
walk and the map are two ways through one review, as proposed in
[review experience direction](../../review-experience-direction.md), section 1.

The map keeps its fidelity rule: every mark on it comes from the code. What the
change adds or removes is computed by the hub from two indexes. The model
describes the system as it was before the change; it never sees the change, so
it cannot absorb it.

## Goals

- A reviewer sees which components, interfaces and connections a change
  touches, at every level of the map.
- New and removed dependencies between components are visible and exact.
- A reviewer can reach every changed item through the map and review it there;
  marks and comments are the same records as in the walk.
- No setup beyond the plugin: everything runs locally inside one review
  session and is discarded with it.

## Non-goals (this phase)

- Persisting a model between sessions, keeping one in the analysed
  repository, or building maps in CI. Every map is built per session.
- Judging whether a new dependency is allowed. Without a previously agreed
  map there is no reference architecture to judge against; new dependencies
  are marked on the map and stay out of findings.
- Comments anchored on components, interfaces or connectors.
- Replacing the shape-of-the-change list or the flow walk.
- Building the map automatically for every review. The reviewer or the agent
  asks for it.

## Anti-goals

- A model that legitimises the change. If the change's own calls could shape
  the model, a violation would turn into a declared requirer and disappear.
- A second progress counter. Review progress stays the review's progress.
- Blocking a review. Nothing the change does stops the map from being shown.

## How it works

### 1. Two versions in one session

A review session compares the working tree (the head) with a base ref. When
the reviewer asks for a map in such a session, the hub:

1. makes a shared clone (`git clone --shared`) of the repository checked out at
   the session's base commit, in a per-user cache directory;
2. indexes that copy with the same provider and indexers as the head;
3. keeps both reference indexes for the session.

The clone borrows the repository's objects and leaves no trace in the reviewed
repository: no worktree entry, no branch, nothing under `.git`, so a crashed
hub or a skipped cleanup leaves nothing in the user's `git worktree list`. The
clone keeps a `.git` of its own, so every git-based code path of the indexers
and the hub works on it. The evidence signals (header comments, registrations)
and the evidence-file checks read base sources, so the copy lives as long as
the session and is removed with it; a missing copy is rebuilt on demand.

The base commit is resolved once, when the session is created, and stored
with the session; the session's diff and the base copy both use that commit
(my call: a base ref such as `main` can move between session creation and the
first map request, and the map must describe the same base as the diff). A
moved ref does not make the session stale; the review stays on the commit it
started from. Sessions created with
`--base empty` have no base and show the plain map, as today.

The base index is built only when a map is requested, so reviews that never
open the map pay nothing.

### 2. The model describes the base

In a review session, `srev map evidence` and `srev map check` work on the base
index. The agent runs the component-map skill unchanged: it reads evidence,
writes a model and checks it until it passes. The check is as strict as today,
on the base. The skill gains one paragraph: in a review session the evidence
is the code before the change, and the hub marks the change on top.

The agent never needs the head's evidence. The change cannot influence the
model, and the agent's work is the same as for an overview map.

### 3. The hub evaluates the head against the model

On submit, the hub applies the stored model to the head index: the same path
patterns assign head files to components, and the same bind entries resolve
against head definitions. It then compares the two versions. Every result is
derived from the indexes and the diff; none comes from the model's judgement.

| Mark | Definition |
|---|---|
| **Changed component** | The component owns at least one changed review item (node or residual) at the head, or owned a file the change deletes. Parents of a changed component are changed. |
| **New dependency** | A crossing (caller component, provider interface) with call sites at the head and none at the base. Drawn as the connector with a "new" marker. |
| **Removed dependency** | A crossing with call sites at the base and none at the head. Drawn dashed with a "removed" marker. |
| **Changed dependency** | A crossing present in both whose call sites differ. Counted on the connector; not drawn differently. |
| **New surface** | A reference at the head that crosses components to a symbol no interface of the provider binds. Drawn as an unnamed interface "new surface" on the provider, with its call sites. |
| **Contract touched** | An interface with a bound function whose definition overlaps changed lines, or a bind entry that resolves at the base and not at the head (removed or renamed). |
| **Unmapped** | A changed file at the head that no component's paths claim (a new top-level directory, say). Listed in a bucket at the level where it falls through. |

The undeclared entries of the base model are drawn in red as today. They
describe the base; the change neither adds nor removes red edges except where
a new or removed dependency coincides with an existing undeclared one.

A crossing is identified by its caller component and the interface (or new
surface) on the provider. Call sites are matched between versions as a set of
keys (enclosing caller symbol, referenced symbol), so code that only moved
within a file is not marked new (my call: the set ignores counts, so calling a
function twice where it was called once does not change a crossing; a renamed
caller or a provider symbol moved to another file gives different keys and
shows as changed).

Cross-process interfaces have evidence files, no call sites. One is marked
**contract touched** when any of its evidence files changed or was deleted
(my call: there is no reference evidence to compare, so the file diff is the
only signal; new or removed cross-process connections are not detected in
this phase).

### 4. The map as a review structure

The map page in a review session shows the marks above at every level. Each
component box carries the count of changed items it owns ("6 changed, 2
reviewed"), using the review's existing node states. The level panel lists the
level's new, removed and changed dependencies, new surfaces and touched
contracts, each linking to its call sites.

Opening a leaf component that owns changed items shows its changed items in a
list: their name, file, change kind and review state, in the review's walk
order when a plan exists, otherwise by file and position. Selecting an item
opens the existing node review view, with its diff, comments and marks.
Marking it reviewed or commenting updates the same node record as the walk.
The reviewer can switch between the map and the walk at any time; both show
the same progress.

Tests are not mapped. A test item appears under the component of the node it
is attached to in the plan; tests with no attachment, and any item when there
is no plan, appear in the level's unmapped bucket under "tests".

Removed items (deleted functions and files) are shown in the component that
owned them at the base, as they appear in the review today.

### 5. When to use it

The map is an optional view. The review skill offers it when the change spans
more than one top-level component of the shape, and the reviewer can ask for it
at any time. A two-file fix does not need it.

## Indexing the base without dependencies

The base copy has no installed dependencies (`node_modules`, a virtual
environment). References between the repository's own files resolve from
source: on a TypeScript monorepo, the cross-file reference keys between its own
files were identical with and without the head's `node_modules` linked in.
scip-python resolves packages from the interpreter environment, which base and
head share. The copy is indexed bare.

Both indexes are limited to tracked files. Indexers also pick up gitignored
build output in the working tree, which a clean checkout of the base lacks;
counting it would mark its references as new.

## Costs and limits

- A second indexer run per review that opens the map. Indexing time is the main
  cost; the base index is built once per session.
- A shared clone of the base commit for the session's lifetime.
- Static references only, as for the overview map.
- A change that moves code between components shows as removed in one and new
  in the other. That is the intended picture of a restructuring.
- A changed file the base model cannot place goes to the unmapped bucket; the
  model is not extended for the head in this phase.
- Stale sessions: when the working tree changes, the session is stale as today;
  recreating it rebuilds the map.

## Later phases

- A model persisted per base commit, so repeated reviews against the same base
  skip the base indexing and the agent's model building. This is a cache; the
  design above does not depend on it.
- A model kept in the analysed repository and maintained in CI. With an agreed
  reference architecture, a new crossing outside it becomes a finding.
- Comments anchored on map elements.
- Folding the shape-of-the-change list into the map.

## Left to the builder

- Where the base index lives on disk and how it is cached in memory.
- Route and response shapes for the overlay, and whether it is computed on
  submit or on read.
- The visual markers for new, removed and changed connectors, within the
  existing map style and both themes.
- The layout of the leaf's changed-item list and how the node review view is
  opened from it.
