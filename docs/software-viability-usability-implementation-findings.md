# Software viability, usability, and implementation findings

**Date:** 2026-07-12  
**Scope:** Repository Markdown, current implementation, and automated verification  
**Status:** Assessment and recommendations — P0 items implemented 2026-07-14; remaining P1 items implemented 2026-07-15 (see below); P2 items 1–3 implemented 2026-07-15

## Implementation status (2026-07-14, branch `fix/viability-p0`)

The full P0 roadmap and the trust-critical P1 items were implemented and merged.
Each task passed an independent spec+quality review; the suite grew from 105 to
142 tests (including a real-SCIP fixture-repository end-to-end test), all green.

**Resolved:**

- Built application launch path (Critical) — server serves `packages/web/dist`
  with SPA fallback and traversal guard, binds `127.0.0.1` by default,
  `pnpm start` added; unregistered `/api/*` returns JSON 404 (`07253f4`, `ebbbcb0`).
- `branch` not the review target (Critical) — short-term contract enforced:
  branch must be `HEAD` or the checked-out branch, else 400 (`575300f`).
- Comment export data loss (Critical) — flat creation-ordered
  `{ comments: [...] }` array with deterministic rowid tiebreak (`97906b1`, `aef0149`).
- Silent git failures (High) — `GitError` with phase; session creation returns
  400 `{ error, phase }` and writes no rows on failure (`3d5e5ad`, `9d4858d`).
- SCIP cache key not content-sensitive + stale detection (High) — shared
  content-sensitive `repoFingerprint`; sessions report `staleReason`
  (`head-moved` / `working-tree-changed`), and the flag is omitted rather than
  claimed `false` when verification is impossible (`deecc13`, `ebbbcb0`).
- No schema migration path (High) — `PRAGMA user_version` ordered transactional
  migrations; newer-than-app databases refuse clearly (`e6c37dc`).
- Review state overwrite after commenting (Medium) — server normalizes
  `reviewed-clean` to `reviewed-commented` when comments exist (`2ae50fe`).
- Local-only deployment (Medium) — loopback default with non-loopback warning (`07253f4`).
- No user-facing README (Medium) — root `README.md` with verified quick start (`019714a`).
- Fixture-repository end-to-end test (P0 test item) — implemented at the API
  level with the real SCIP provider rather than Playwright (`886cedb`).
- Bonus fix found by the E2E test: `getFlows` counted test callers when picking
  flow entries, so tested production functions never headed flows (`208dae5`).
- Exported comments lack hunk/structural context (High) — hunk snippets are
  server-derived at comment creation from the node's real diff lines;
  structural context is derived at export from stored call/test edges; the
  export envelope carries branch/baseRef/headSha and node line ranges.
- Structural exploration missing from the UI (High) — collapsible Relations
  panel under the diff (direction, file, changed/test/in-walk/review state)
  with breadcrumb detours and a "Return to review walk" action.
- Diff reconstruction loses source coordinates (Medium) — `NodeDiff` now
  carries hunk-accurate `DiffLine[]` (old/new file line numbers); the web
  diff renders them directly instead of re-diffing text blobs.
- Runtime API validation insufficient (Medium) — zod schemas on all mutating
  routes with structured `{ error, issues }` 400s; comment creation enforces
  node/session ownership.
- Entry-point inference too narrow / no confidence (Medium) — pluggable
  evidence (`graph-root` / `exported` / `.crw-entry-points.json` configured
  entries) with deterministic 0.4/0.7/1.0 confidence, exposed via the flows
  API and a plan-view chip; configured entries head flows despite callers.
- Residual bounding boxes (Medium) — residual pseudo-nodes store their exact
  ranges (schema v3 `nodes.residual_ranges`); the diff pane renders only
  those ranges, so hunks covered by function nodes are never shown twice.
- Bulk mutations non-atomic (Medium) — `PATCH /api/sessions/:id/nodes`
  applies a bulk status change in one SQLite transaction (all-or-nothing,
  comment normalization preserved); session creation and plan replacement
  are transactional; edge insertion uses a stableId map instead of repeated
  scans; the web "mark remaining" sends one request and one invalidation.

**Still open (unchanged findings below remain accurate):** SCIP edge
semantics; error/loading/empty states; lint no-op; SSE cleanup. Deferred
review triage lives in `.superpowers/sdd/progress.md` on the implementation
branch.

## Executive summary

Code Review Walkthrough has a strong and credible product thesis: large changes,
especially AI-generated changes, are often easier to understand in behavioral and
dependency order than in file-tree order. The project has also developed several
thoughtful mechanisms that distinguish it from a simple reordered diff viewer:

- mechanically enforced change coverage;
- execution-flow review units with many-to-many membership;
- explicit handling of changes that do not appear in a code graph;
- shared review state when a changed node appears in several flows;
- relevance-pruned flow trees;
- skill-generated labels and ordering, with reviewer correction;
- a fast keyboard-oriented review loop;
- persisted review position and stale-session signaling.

The current software is best described as a promising TypeScript-first alpha. The
architecture is sensible and the automated test suite is substantial, but several
issues prevent the tool from being a dependable everyday review environment. The
most serious are:

1. The packaged server does not appear to serve the built web UI even though the
   skill launches the server URL.
2. The supplied `branch` is not actually used as a review target; graph and diff
   collection operate on the current working tree relative to `baseRef`.
3. Multiple comments on one node overwrite each other during export.
4. Comments currently contain neither a hunk snippet nor structural context.
5. The SCIP cache and stale-session detector do not reliably notice continued
   edits to an already-dirty file.
6. Git failures can be silently interpreted as absent or unchanged data, which is
   dangerous for a tool promising complete coverage.
7. The current UI no longer exposes much of the caller/callee navigation that made
   the original concept distinctive.

The next milestone should therefore be a trustworthy end-to-end review of a real
TypeScript change, rather than another broad feature wave. Packaging, snapshot
correctness, error visibility, comment quality, and one genuine end-to-end test
should take priority.

## Assessment

### Product viability

**Assessment: strong thesis, viable initial niche, broader applicability not yet
demonstrated.**

The tool addresses a real problem. File organization is an imperfect proxy for
runtime behavior, and conventional diff tools make it difficult to review a helper
in the context of all changed call paths that depend on it. The need becomes more
acute as agents produce larger, cross-cutting changes with weak commit structure.

The most viable initial market is:

- TypeScript repositories;
- medium and large pull requests;
- changes spanning handlers, services, helpers, and tests;
- individual reviewers already working with an agentic coding environment;
- local, security-conscious workflows where uploading a repository is undesirable.

The present implementation does not yet justify a general multi-language claim.
The default provider directly invokes `scip-typescript`, and the quality of flow
construction depends on TypeScript-specific index output. A provider interface is
the correct architectural preparation, but an interface alone is not evidence that
Python, Go, Java, Rust, or mixed-language repositories will produce equally useful
review units.

Recommended initial positioning:

> A TypeScript-first, coverage-guaranteed review walkthrough that orders every
> changed hunk by execution flow while preserving direct structural exploration.

This promise is narrow enough to validate and strong enough to be valuable.

### Usability

**Assessment: promising interaction model, but incomplete onboarding and several
trust-breaking gaps.**

The July review-walk improvements are well chosen. `j`/`k`, next-unreviewed,
`r` to review and advance, persisted position, auto-collapse, bulk marking, plan
reordering, inline renaming, and test chips all address repetitive review work.
They are more likely to improve daily usability than a large always-visible graph.

However, the product currently asks the reviewer to trust several abstractions
without providing enough inspection or failure feedback:

- A flow is presented as meaningful without showing why an entry point was chosen.
- Caller/callee data exists but is not exposed as a deliberate navigation surface.
- A coverage count may look complete even if a Git operation silently failed.
- A session may appear current despite further edits to an already-dirty file.
- Comments are node-level prose with no concrete line or hunk anchor.
- It is unclear from repository documentation how a new user installs the skill,
  starts the correct processes, chooses a provider, and completes a full review.

These are not cosmetic concerns. Review software is useful only when reviewers can
understand what is included, what is omitted, and how each conclusion was derived.

### Implementation

**Assessment: good modular structure and testing discipline, with correctness and
operational gaps typical of a fast-moving alpha.**

The implementation benefits from several sound decisions:

- The server is the single authority for Git, graph, review state, and comments.
- Graph extraction is behind a small `GraphProvider` interface.
- Coverage computation and walk ordering are pure, independently tested modules.
- Residual changes are represented through the same node model rather than a
  parallel exception path.
- Flow-unit membership is many-to-many and review status remains node-level.
- The SCIP cache stores the in-flight promise, preventing duplicate concurrent
  index runs.
- TypeScript strict mode is enabled and the codebase remains relatively compact.

The major implementation weaknesses are primarily around boundaries: process
startup, repository snapshots, Git error semantics, database evolution, input
validation, and comment export. These should be corrected before increasing the
scope of graph inference or planning intelligence.

## Design evolution: strength and risk

The documentation describes an important evolution:

1. The original product centered an interactive call graph, focused neighborhood,
   frontier agenda, and top-down/bottom-up movement.
2. Early implementation showed all nodes in a full graph.
3. The skill-driven design removed the graph view and replaced it with a
   coverage-guaranteed ordered plan of flow and orphan units.
4. Later work improved flow relevance, merging, coverage, and review-loop speed.

This pivot has a strong rationale. Full graphs often become visual noise, while a
linear review plan gives the reviewer an obvious next action. Mechanically complete
coverage is also more important than graph spectacle.

The risk is loss of differentiation. In the current UI, the product is close to an
intelligently ordered list of changed functions. The original capability to move
up to callers, down to callees, inspect unchanged usages, and return to the walk is
not visibly present even though node-detail APIs return callers and callees.

The recommendation is not to restore a large graph canvas. Instead, add a compact
structural navigation drawer containing:

- direct callers;
- direct callees;
- linked tests;
- changed/unchanged state;
- the current walk breadcrumb;
- a clear action for returning to the planned sequence.

This would recover the essential structural-review value without recreating the
legibility problems that motivated removal of the graph.

## Detailed findings and recommendations

### Critical: built application launch path is incomplete

The orchestration script opens the server URL, normally
`http://localhost:3456?session=...`. The server mounts API routes but does not mount
the existing static-route helper. The web build is emitted into
`packages/web/dist`, while development normally uses a separate Vite server.

Relevant code:

- `packages/skill/src/orchestrate.ts` — `launchUI` opens `SERVER_URL`.
- `packages/server/src/index.ts` — starts the Hono server.
- `packages/server/src/app.ts` — mounts API routes only.
- `packages/server/src/static.ts` — defines static serving but is unused.
- `packages/web/vite.config.ts` — proxies `/api` to port 3456 in development.

#### Impact

A successful skill run can launch a URL that does not contain the application.
This prevents the documented production workflow from completing end to end.

#### Recommendation

Create explicit development and production launch contracts:

- Production:
  - build the web package;
  - mount its output in the server;
  - serve `index.html` as the SPA fallback;
  - add a `start` script for the compiled server;
  - make the skill open the server URL.
- Development:
  - make the Vite URL explicit through `CRW_UI_URL`, or have the root development
    command pass it to the skill;
  - keep API calls proxied to the server.

Add a smoke test that starts the compiled server and verifies that `/`, a static
asset, `/health`, and a session URL all return expected content.

### Critical: `branch` is not the actual review target

`ScipGraphProvider.getChangeSubgraph` ignores its branch argument. Diff helpers run
`git diff <baseRef>` in the current repository, and SCIP indexes the current working
tree. The `branch` field is therefore primarily session metadata.

#### Impact

If the requested branch is not checked out, the application reviews a different
tree than the user requested. Even when it is checked out, unstaged and staged
working-tree edits may be included without an explicit statement of that behavior.

This is a fundamental correctness issue because the session title can name one
branch while the contents originate from another state.

#### Recommendation

Choose and enforce one of two contracts.

**Short-term contract:** review the current working tree only.

- Require `branch` to be `HEAD` or the currently checked-out branch.
- Reject mismatches with a clear 400 response.
- Display the exact HEAD SHA and whether staged, unstaged, and untracked changes
  are included.
- Rename ambiguous CLI options if necessary.

**Full branch contract:** review an arbitrary ref.

- Resolve base and target SHAs at session creation.
- Create a temporary Git worktree at the target SHA.
- Run SCIP and source extraction against that worktree.
- Diff `base...target` using explicit refs.
- Store the resolved SHAs in the session.

The short-term contract is sufficient for an alpha and substantially easier to
make trustworthy.

### Critical: comment export loses multiple comments on one node

`exportComments` creates a `Record<string, ExportedComment>` keyed by node ID. Each
new comment for the same node assigns to the same key, overwriting the previous
comment.

#### Impact

A reviewer can see and author multiple comments in the UI, but only the final one
survives export. Since structured comments are one of the two declared external
contracts of the product, this is a release-blocking data-loss defect.

#### Recommendation

Change the export structure to either:

```json
{
  "nodes": {
    "node-id": {
      "stableId": "...",
      "comments": []
    }
  }
}
```

or a flat ordered array of comments, each carrying node metadata. An array is
simpler for downstream agents; grouping can be derived.

Add tests with two or more comments on the same node and preserve their creation
order.

### High: exported comments lack hunk and structural context

The comment UI sends empty strings for both `hunkSnippet` and
`structuralContext`. The database and export format support these fields, but the
product does not populate them.

#### Impact

The external fixing agent receives a function or file identity and prose, but not
the exact code that prompted the observation or the relevant callers/callees. This
weakens the stated benefit of node-stable comments and increases the chance of a
fix being applied to the wrong occurrence or interpreted too broadly.

#### Recommendation

Implement in two stages:

1. Automatically populate structural context on the server during export from
   stored edges or fresh provider neighbors. Do not trust client-authored context.
2. Add line or hunk selection to the diff. Store:
   - old and new line ranges;
   - a bounded snippet;
   - the node stable ID;
   - file path;
   - session base and target SHAs.

Until line selection exists, populate `hunkSnippet` with the bounded changed
fragment currently shown for the node rather than leaving it empty.

### High: SCIP cache key is not content-sensitive

The cache key combines HEAD with `git status --porcelain`. Porcelain status shows
the category of change, not its content. Once a tracked file is modified, further
saves can leave the status string unchanged.

For example, all of the following edits may produce the same ` M src/a.ts` line:

- initial modification;
- addition of a new function call;
- deletion of that call;
- replacement with an entirely different implementation.

#### Impact

The graph provider can return a stale graph after the working tree changes. This is
particularly damaging because the cache optimization is applied to caller/callee
and flow queries that reviewers use to understand the current code.

#### Recommendation

Use a content-sensitive repository fingerprint. A practical key can hash:

- resolved HEAD SHA;
- `git diff --binary HEAD` output for tracked worktree changes;
- `git diff --binary --cached HEAD` if staged state is not already covered;
- paths plus content hashes for relevant untracked source files.

For large repositories, an alternative is a file watcher that invalidates the
single cache entry on relevant filesystem changes. The safest initial version is a
hash of Git diff content because session creation is already batch-oriented.

Update the cache test so it edits an already-dirty file twice without changing its
porcelain status and asserts that indexing runs again.

### High: stale-session detection misses dirty-tree changes

The stale flag compares only the session HEAD SHA with the current HEAD SHA.

#### Impact

A reviewer can create a session, continue editing an already-checked-out branch,
and see no stale warning as long as no commit is made. The diffs and stored graph
nodes can then describe different repository states.

#### Recommendation

Store the same content-sensitive repository fingerprint used by the graph cache.
Expose both:

- `stale: boolean`;
- a reason, such as `head-moved`, `working-tree-changed`, or `repo-unavailable`.

Do not auto-refresh in v1; an explicit warning and “create fresh session” action
are sufficient.

### High: silent Git failures undermine the coverage guarantee

Several helpers convert Git errors to `null`, `[]`, or current-source fallbacks.
This is reasonable for optional context, but not for the inputs to a completeness
claim.

Examples include:

- changed-file discovery returning an empty list;
- changed-range discovery returning `null`;
- diff retrieval falling back to current source;
- HEAD lookup returning `null`.

#### Impact

The interface can report complete coverage even though it failed to enumerate the
diff. “No changes” and “could not read changes” are semantically different states
and must not be conflated.

#### Recommendation

Introduce an explicit session-build result with diagnostics:

```ts
interface SessionDiagnostics {
  complete: boolean;
  errors: Array<{
    phase: "resolve-ref" | "list-files" | "read-diff" | "index";
    file?: string;
    message: string;
  }>;
}
```

- Fail session creation when base/target resolution or changed-file enumeration
  fails.
- Allow per-file degradation only if the UI prominently reports incomplete
  coverage.
- Never display a normal green coverage count when diagnostics are incomplete.
- Capture Git stderr so expected negative tests do not flood test output.

### High: database schema has no migration path

Database initialization runs `CREATE TABLE IF NOT EXISTS`, which does not add new
columns to an existing table. The project has already added fields such as
`head_sha`, unit `kind`, membership JSON, and `auto` during rapid iteration.

#### Impact

An older `review.db` can fail at runtime after an application update, or retain an
incompatible shape. Durable sessions are therefore not safely durable across
versions.

#### Recommendation

Add a schema version table and ordered transactional migrations. At minimum:

- version every released schema;
- test migration from the earliest retained schema to current;
- back up or clearly reject a database newer than the application;
- decide how long old review sessions are supported.

For an alpha, it is acceptable to provide an explicit “database format changed;
archive or recreate” message, but silent incompatibility is not acceptable.

### High: structural exploration is missing from the current UI

Node detail responses include callers and callees, but `SplitLayout` displays only
the diff and comments. Flow tracks include selected unchanged context, yet there is
no general local move to usages or dependencies.

#### Impact

The implementation does not fully deliver these documented behaviors:

- bottom-up movement as a local action;
- deliberate navigation into unchanged code;
- understanding where a helper is used;
- returning to the planned walk after an exploratory detour.

#### Recommendation

Add a collapsible Relations panel in the diff pane. For each neighboring node show:

- relationship direction and type;
- label and file;
- changed/unchanged/test state;
- whether it belongs to the planned walk;
- whether it has already been reviewed.

Selecting a neighbor should preserve a breadcrumb stack and provide a prominent
“Return to review walk” action. This is enough to implement the intended top-down
walk plus local bottom-up movement without a full graph view.

### Medium: diff reconstruction loses trustworthy source coordinates

The server reconstructs old and new text fragments from unified hunks. The generic
diff component then compares those fragments as new strings. The displayed gutter
coordinates therefore do not necessarily correspond to actual old and new file
line numbers.

#### Impact

Reviewers may have difficulty relating a comment to the repository, especially in
long functions or residual file nodes. It also makes accurate line-level comments
harder to implement.

#### Recommendation

Preserve parsed hunk coordinates in the API and render a hunk-aware diff model:

```ts
interface DiffLine {
  type: "context" | "added" | "removed";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}
```

This can still be shown side by side, but original coordinates and selections will
remain reliable. For unchanged context nodes, source lines should start at the
node's actual `startLine`.

### Medium: residual pseudo-nodes trade completeness for duplicate review

One residual pseudo-node is created per file using the bounding box of all residual
ranges. If imports at the top and a module constant at the bottom change, the box
can enclose changed functions already represented as real nodes.

#### Impact

The reviewer may see the same hunks in a flow node and a file residual node. Shared
review state does not remove this visual duplication because they are different
nodes.

#### Recommendation

Keep the one-node-per-file approach initially, but store the actual residual ranges
instead of only the bounding box. Diff rendering should include only those ranges.
This preserves one plan chip without re-showing covered function hunks.

Longer term, promote supported type declarations and module constants to first-class
semantic nodes where indexers provide suitable data.

### Medium: entry-point inference is too narrow and lacks confidence reporting

SCIP flows currently begin at non-test functions that have callees and no callers.
Framework entry points are often referenced indirectly through route registration,
dependency injection, decorators, configuration, event listeners, or reflection.
Conversely, internal utilities can look like roots when the index lacks external
callers.

#### Impact

Flows can be fragmented, missing, or labeled from accidental graph roots rather
than true externally triggered behavior. Orphan coverage prevents changes from
being hidden, but it does not make the resulting plan semantically good.

#### Recommendation

Introduce pluggable entry-point detectors with evidence and confidence:

- graph root;
- exported symbol;
- HTTP route registration;
- CLI command registration;
- job or event-handler registration;
- explicit user/project configuration.

Expose the reason in plan context and the UI. The skill can then order units using
both structure and confidence rather than treating every graph root as equivalent.

### Medium: SCIP edge semantics remain approximate

SCIP references are used to infer calls, but SCIP does not mark every reference as
a call. Passing a function as a value, registering a callback, or re-exporting a
symbol can be interpreted as an edge.

#### Impact

Most derived edges may be useful, as the repository experiment suggests, but the
tool has no visible way to express uncertainty. An inaccurate flow can imply a
runtime relationship that does not exist.

#### Recommendation

- Represent edge provenance and confidence internally.
- Distinguish direct call references from callback registration or general symbol
  references when an indexer can provide the evidence.
- Use targeted LSP call hierarchy only for ambiguous or high-impact edges, rather
  than crawling the entire graph.
- Add real-repository fixtures that intentionally include callbacks, re-exports,
  higher-order functions, and interface dispatch.

### Medium: runtime API validation is insufficient

Request bodies are accepted through TypeScript type assertions, which do not
validate JSON at runtime. Invalid status values, malformed units, missing labels,
or node IDs from another session may reach repository functions or SQLite.

#### Impact

Malformed skill output or manual API usage can produce server errors, inconsistent
sessions, or comments attached outside the intended session.

#### Recommendation

Add runtime schemas for all mutating routes. Validate at least:

- branch/base-ref/session inputs;
- allowed review statuses;
- unit discriminated unions;
- nonempty labels and entry lists;
- duplicate IDs;
- node and session ownership for comments;
- comment length and nonempty text;
- legal reorder positions.

Return structured 4xx errors that the CLI and web UI can display.

### Medium: node review state can be overwritten after commenting

Submitting a comment marks the node `reviewed-commented`, but the general “Mark
reviewed” action can later set the same node to `reviewed-clean`. The data model
defines the status as a single mutable value rather than deriving commented state
from existing comments.

#### Impact

A node with comments may appear clean, reducing the accuracy of review summaries.

#### Recommendation

Model review decision and comment presence separately, or derive the visible status:

- decision: `unreviewed | accepted`;
- `hasComments`: computed from comments;
- visible state: unreviewed, reviewed-clean, or reviewed-commented.

If the current enum is retained, the server should refuse or normalize
`reviewed-clean` when comments exist.

### Medium: bulk review mutations are non-atomic and potentially noisy

“Mark remaining reviewed” sends one mutation per node. Query invalidation occurs
for every successful request.

#### Impact

Large units create unnecessary requests and repeated refetches. A partial failure
can leave a unit half-updated without a useful summary.

#### Recommendation

Add a bulk status endpoint scoped to a unit or explicit node IDs. Apply changes in
one SQLite transaction and return the updated node set. Invalidate queries once.

### Medium: production error, loading, and empty states need distinction

The React queries are generally consumed through optional data. Loading, 404,
network failure, invalid session, no changes, no plan, and graph-provider failure
can therefore collapse into similar empty views.

#### Impact

Users may be told to run the skill when the actual problem is a dead server,
invalid session ID, missing base ref, or failed SCIP index.

#### Recommendation

Add explicit application states for:

- loading session;
- session not found;
- server unreachable;
- graph/index failure;
- incomplete Git data;
- no changes;
- plan not yet submitted;
- stale session.

Include recovery actions such as retry, copy diagnostics, or create a new session.

### Medium: local-only deployment should be enforced

The design specifies localhost-only operation, but the server does not explicitly
bind to a loopback hostname.

#### Impact

Depending on runtime defaults, the unauthenticated review API could listen on other
interfaces. Review comments and repository-derived source fragments should not be
exposed unintentionally.

#### Recommendation

Bind to `127.0.0.1` by default. Require an explicit environment variable to bind
elsewhere and print a warning when doing so.

### Medium: there is no clear user-facing README

The repository contains rich design and implementation documents but no concise
user guide. `AGENTS.md` is primarily contributor guidance and contains details that
have already diverged from the implementation, such as provider-default behavior.

#### Impact

It is difficult for a new user to determine:

- prerequisites;
- installation steps;
- how the Claude skill is installed or invoked;
- which provider is active;
- how to review the current branch;
- where the database is stored;
- how to export comments;
- known language and graph limitations;
- how to recover from a stale or failed session.

#### Recommendation

Add a root `README.md` with:

1. a two-minute quick start;
2. exact development and production commands;
3. a small screenshot or short workflow diagram;
4. current TypeScript-first scope;
5. provider configuration;
6. data and privacy behavior;
7. troubleshooting;
8. links to design documents for contributors.

Also add a short “current architecture” document so readers do not need to
reconstruct the latest state from chronological specs and plans.

### Low: automated lint command is a no-op

The root `lint` command runs recursive package lint scripts, but none of the package
manifests defines one.

#### Impact

`pnpm lint` exits successfully without performing any validation, which gives a
false signal in local development and CI.

#### Recommendation

Add ESLint or another selected linter to every applicable package, or remove the
root command until it is real. Include rules for React hooks, unused imports, and
unsafe TypeScript patterns.

### Low: SSE and several UI fields appear vestigial

An SSE endpoint exists, but there is no evident client subscription and no event
emission from mutations. UI state still contains fields associated with earlier
graph/walk designs.

#### Impact

Dead or partial features make it harder to understand the actual architecture and
increase maintenance cost.

#### Recommendation

Either complete real-time synchronization or remove SSE for the single-user v1.
Remove unused state such as obsolete overview, unit-index, and walk-path fields
unless the Relations drawer will use them immediately.

### Low: documentation status and implementation status have diverged

Several July designs are marked “proposed,” but their implementation is present and
merged. Earlier design sections still describe the removed graph UI and CRG-first
architecture, while current code uses SCIP by default.

#### Impact

New contributors cannot easily distinguish historical decisions, current behavior,
and future work.

#### Recommendation

- Mark implemented specs as implemented, with commit or release references.
- Add superseded notices to old UI sections.
- Keep one short current-state architecture document authoritative.
- Treat chronological specs as decision history rather than operating
  documentation.

## Suggested usability improvements

### Review-loop improvements

1. Make the visible “Mark reviewed” button behave like the `r` shortcut and advance
   to the next unreviewed node. Provide a modifier or secondary action to stay.
2. When no unreviewed nodes remain, change the next button to a disabled “All
   changes reviewed” state and show a completion summary.
3. Show the current position, for example `12 of 38`, in the diff header.
4. Provide visible previous/next controls for users who do not know shortcuts.
5. Keep the shortcut overlay discoverable through a labeled help button, not only
   the `?` key.
6. Add an undo action after marking a node or an entire unit reviewed.

### Plan improvements

1. Show why each flow is considered an entry point.
2. Show changed-node overlap when several flows were merged.
3. Allow moving a node from an orphan group into another orphan group without
   rebuilding the plan through the skill.
4. Distinguish semantic orphan types:
   - graph extraction gap;
   - file/config change;
   - changed test;
   - unreachable changed function;
   - coverage backstop.
5. Show a warning when the plan has unusually many orphan nodes or no usable flows;
   that is a graph-quality signal, not just a plan layout.

### Diff and comment improvements

1. Preserve real source coordinates.
2. Support selecting one or more lines before commenting.
3. Display comment anchors inline in the diff.
4. Allow editing and deleting comments.
5. Add severity or category only if downstream workflows need it; do not overload
   the initial comment form.
6. Provide a final comments review screen before export.
7. Show exported comment count and destination/command clearly.

### Trust and diagnostics improvements

1. Display exact base and target SHAs.
2. Display whether working-tree changes were included.
3. Display provider name, index timestamp, and graph warnings.
4. Surface incomplete coverage separately from unassigned-but-known changes.
5. Provide a session diagnostics panel with copyable information.

## Suggested implementation improvements

### Snapshot model

Introduce an immutable session snapshot identity:

```ts
interface RepoSnapshot {
  repoRoot: string;
  baseRef: string;
  baseSha: string;
  targetRef: string;
  targetSha: string;
  workingTreeFingerprint?: string;
  includesStaged: boolean;
  includesUnstaged: boolean;
  includesUntracked: boolean;
}
```

All graph, diff, source, coverage, and export work for a session should refer to the
same snapshot. This resolves several issues at once: ambiguous branches, stale
sessions, stale caching, reproducible comment anchors, and diagnostics.

### Provider diagnostics

Extend provider results with nonfatal warnings and provenance:

```ts
interface GraphDiagnostics {
  provider: string;
  language: string;
  indexedFiles: number;
  skippedFiles: string[];
  warnings: string[];
}
```

This information should be stored on the session. It lets the UI distinguish “all
known changes covered” from “the indexer skipped half the repository.”

### Transactions and query efficiency

Use SQLite transactions for:

- session creation and node/edge insertion;
- plan replacement and coverage-backstop insertion;
- bulk review updates;
- comment creation plus status update.

Session creation currently performs repeated node lookups when inserting edges.
Build a `Map<stableId, nodeId>` once rather than searching the full node array for
each edge.

### Runtime boundaries

- Validate every mutating request.
- Add a centralized Hono error handler.
- Return stable error codes for CLI consumption.
- Add timeouts and bounded stderr/stdout capture for external indexer and Git
  processes.
- Report the command phase without leaking unnecessary machine paths.

### Test strategy

The unit and route coverage is a good foundation. The missing layer is confidence
that the actual processes and real provider work together.

Add these tests in priority order:

1. **Packaged smoke test:** build, start server, load the web application.
2. **Fixture-repository E2E:** create a small real TypeScript repo and review a
   branch containing:
   - a changed handler;
   - a shared helper;
   - a changed test;
   - an import or type change;
   - a config file change.
3. **Playwright workflow:** create session, submit plan, navigate with keyboard,
   leave two comments on one node, mark nodes reviewed, reload, export.
4. **Dirty-tree staleness:** edit an already-dirty file and confirm cache and stale
   state change.
5. **Database migration:** open an old schema and migrate it.
6. **Graph-quality corpus:** callbacks, decorators, route registration, interface
   dispatch, re-exports, and test-only functions.

The current test suite was run during this assessment:

- 17 test files passed;
- 105 tests passed;
- TypeScript typechecking passed;
- all package builds passed;
- the lint command completed but performed no linting because packages do not
  define lint scripts.

Some negative-path tests print large Git diagnostics even when they pass. Capture
stderr in expected-failure helpers to keep CI output useful.

## Prioritized roadmap

### P0 — make one review trustworthy end to end

1. Serve the production web build from the server and add a working start command.
2. Define and enforce current-working-tree versus arbitrary-branch semantics.
3. Fix multi-comment export data loss.
4. Fail visibly on incomplete Git/diff collection.
5. Add a fixture-repository Playwright smoke test through comment export.
6. Add a root README with exact quick-start instructions.

### P1 — restore the structural value proposition

1. Add the caller/callee/test Relations drawer and breadcrumb return path.
2. Preserve real diff line coordinates.
3. Populate structural context and bounded hunk snippets in comments.
4. Use content-sensitive snapshot/cache fingerprints.
5. Add database migrations and request validation.

### P2 — improve review quality and scale

1. Add entry-point provenance and confidence.
2. Store exact residual ranges rather than a bounding box.
3. Add bulk mutation endpoints and transactions.
4. Add provider/session diagnostics.
5. Test larger repositories and measure indexing, session creation, and navigation
   latency.

### P3 — expand scope only after validation

1. Add a second production-quality language provider.
2. Evaluate targeted LSP refinement for demonstrably ambiguous edges.
3. Explore message-flow providers after the call-flow experience is proven.
4. Consider team or hosted workflows only after the local single-user contract is
   stable.

## Product validation plan

Before expanding the feature set, dogfood the tool on 10–20 real reviews and record:

- total changed files and lines;
- semantic nodes versus residual nodes;
- percentage of changed nodes appearing in useful flows;
- number and cause of unassigned changes;
- duplicate appearances per changed node;
- plan units renamed or reordered by reviewers;
- flows merged or judged incorrect;
- time from session start to first reviewed change;
- review completion time compared with a normal diff tool;
- comments created and whether their anchors were sufficient for a fixing agent;
- graph or diff correctness failures;
- sessions abandoned and why.

Qualitative questions matter as much as speed:

- Did the order help the reviewer form a correct mental model?
- Did unchanged context answer questions without opening an editor?
- Did the reviewer trust the coverage count?
- Did shared review state remove repetition?
- Were orphan units useful or merely a fallback file list?
- Did the tool find issues a file-order review would likely miss?

The product should proceed toward broader language support only if reviewers report
that flow ordering and local structural exploration materially improve understanding,
not merely that the interface is pleasant.

## Final recommendation

Continue development. The project has a defensible idea, a coherent architecture,
and unusually thoughtful coverage semantics. The pivot from a full graph canvas to
an ordered plan was sensible, provided the product restores lightweight local
caller/callee exploration.

Do not treat the current build as a dependable v1 yet. First establish a narrow,
honest TypeScript workflow that:

- launches correctly from a clean installation;
- reviews exactly the repository snapshot named by the session;
- proves that every changed hunk was either covered or explicitly failed;
- preserves every comment with an actionable anchor;
- warns whenever graph or diff data may be stale or incomplete;
- completes one real review through a tested production path.

Once those properties hold, the existing planning, coverage, and review-loop work
forms a strong base for meaningful dogfooding and product validation.
