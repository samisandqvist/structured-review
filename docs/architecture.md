# Architecture

Structured Review is a local, single-reviewer tool. An agent prepares a review
plan, a human walks the represented changes, and the agent harvests comments.
Applying fixes, publishing GitHub feedback, and carrying review decisions across
revisions are separate workflows.

This document describes the implementation checked on 2026-09-12. See the
[review model](review-model.md) for behavioral decisions, the
[CLI reference](cli-and-configuration.md) for commands and configuration, and the
[quality harness](harness.md) for verification policy.

## Boundaries

| Component | Responsibility | Boundary |
| --- | --- | --- |
| `packages/skill` | Agent instructions, planning context, plan submission, server lifecycle, comment harvesting | Uses the server over HTTP; does not access its SQLite database directly |
| `packages/server` | Git/diff access, graph providers, sessions, plans, comments, review state, static UI | The single stateful hub; Hono and Node's built-in `node:sqlite` |
| `packages/web` | Plan tracks, diff display, navigation, comments, review marks | Uses the hub; never reads Git or indexers directly |
| `plugin/`, `plugins/structured-review/` | Claude Code and Codex distribution packages | Generated from the same runtime and skill sources |

The agent owns interpretation of intent and plan narratives. The server owns
membership, validation, persistence, and coverage arithmetic. It stores narrative
text but neither generates it nor makes model API calls. React/TanStack Query
manage the browser's server data; Zustand holds local navigation/layout state.

## Session lifecycle

1. `srev serve` starts or reuses a hub for the selected repository, checking its
   repository identity before reuse.
2. Session creation compares the tracked working tree with the supplied base,
   obtains graph nodes and edges, reconciles changed nodes, and adds residual
   items for changed text outside graph spans. Nodes and review state persist in
   SQLite. Git/indexing failures are surfaced rather than presented as a complete
   successful review.
3. `srev context` provides flows, change summaries, orphan groups, merge
   suggestions, and commit subjects. Numeric flow references and file globs
   avoid requiring an agent to transcribe long stable identifiers.
4. Plan submission resolves membership, derives supporting attachments, and
   places remaining changes in a visible unassigned group. Replacing the plan
   and its overview is transactional; replanning does not reset node review
   state.
5. The browser reads the plan and node diffs through the hub. Comments and marks
   survive browser reload and hub restart; the browser owns its navigation
   position and layout preferences.
6. `srev comments` exports the review. Export includes multiple comments per
   node, line anchors when present, and review-wide notes. Publishing that output
   is an external action.

The reviewed input is the checked-out working tree, not an arbitrary branch
checkout or an immutable snapshot. Untracked files must be staged to enter the
review. A stored content fingerprint lets the UI and CLI report a stale session;
recreate it after changes. Freshness detection is broader than review membership:
untracked content can invalidate the fingerprint without becoming a review item.

## Graph providers and indexing

[`GraphProvider`](../packages/server/src/graph/provider.ts) exposes change
subgraphs, neighboring nodes, flows, and optional indexing warnings and file
dependencies. SCIP is the default; CRG and a test stub use the same boundary.
Call and test edges support navigation. File dependencies support attachment
derivation and retain whether a reference is to a value or only a type.

The SCIP provider discovers project roots from language markers and runs one
indexer job per retained root. A root nested under another root of the same
language is omitted; nested roots of different languages remain. Decoded document
paths are rebased to repository-relative paths before documents are combined into
one graph. TypeScript/JavaScript, Python, and Java use separate indexers; combining
their indexes does not create cross-process request traces.

Java indexing uses an external launcher or coursier and invokes the project's
build. A missing launcher produces visible warnings and leaves Java text changes
reviewable as residuals. A launcher that is present but fails is an indexing
error. The decoder also rejects an empty index for a root known to contain
sources. Indexer absence and indexer failure have deliberately different outcomes.

Static references are evidence, not proof of execution. Callbacks, dependency
injection, unresolved dependencies, and heuristic entry detection can limit flow
quality. Explicit entry-point configuration provides an override. Entry confidence
is a heuristic ranking, not a calibrated probability of correctness.

Implementation: [root discovery](../packages/server/src/graph/roots.ts),
[SCIP orchestration](../packages/server/src/graph/scip.ts), and
[entry evidence](../packages/server/src/graph/entry-points.ts).

## Caching and freshness

The provider caches the combined graph by a content-sensitive repository
fingerprint. Individual jobs cache decoded documents by language, root, and
subtree fingerprint. These keys include tracked diff content and relevant
untracked content; Git status labels alone cannot detect edits to an already
modified file.

Both caches share in-flight promises between concurrent callers. Failed entries
are evicted so later requests can retry; fingerprint failures cause misses.
`SCIP_NO_CACHE=1` bypasses both cache layers. Per-job working-tree fingerprints
include language-specific sources, build/configuration markers, and lockfiles.
The committed tree component can still over-invalidate a job, especially one at
the repository root. External toolchains and user-global configuration are not
fully represented in these fingerprints.

See [fingerprint implementation](../packages/server/src/diff.ts) and
[indexing follow-ups](indexing-follow-ups.md) for remaining limitations. Cache
validity does not make a session an immutable source snapshot.

## Persistence and distribution

Versioned SQLite migrations support existing review state. Session/plan writes
and bulk review mutations use transactions to avoid partial updates. Node review
state is shared when a node appears in multiple units; attachments persist with
the plan so web and CLI consumers do not independently infer their ownership.

The server serves the built Vite application in distribution packages. It binds
to loopback and checks request hosts, browser origins, and JSON content types;
these checks do not authenticate local processes. Plugin state lives in the host
data directory or XDG fallback, outside the reviewed repository. Source mode has
different defaults documented in the CLI reference.

[`scripts/build-plugin.mjs`](../scripts/build-plugin.mjs) generates both plugin
packages. Runtime or skill changes require `pnpm build && pnpm build:plugin`;
generated package files are not edited by hand. Build, package freshness,
persistence, and browser checks are defined in the quality harness.
