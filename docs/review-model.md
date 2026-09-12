# Review model and design decisions

These are the useful behavioral decisions behind the current review experience,
checked against the implementation on 2026-09-12. For setup and exact command
schemas, use the [CLI reference](cli-and-configuration.md) and
[agent skill](../packages/skill/skill.md). For component boundaries, see
[architecture](architecture.md).

## Review universe and coverage

The review universe consists of represented changed nodes plus per-file residual
items for changed text outside those nodes. Residuals make imports, types,
configuration, documentation, and unindexed source visible even when the graph
contains no corresponding function. One residual item per file avoids flooding
the plan with separate chips for individual ranges; its stored exact ranges avoid
repeating intervening function hunks.

Every represented changed item must remain visible in a submitted plan, either
in an authored unit, as a counted attachment, or in the server-created
**Unassigned changes** group. The unassigned count measures work the authored
plan has not placed. A full plan is not evidence that all possible Git changes
are represented or that the code is correct: untracked files, pure renames,
file-mode-only changes, and binary viewing have the limits described in the
[README](../README.md#what-the-review-includes).

Membership can be many-to-many: several entry points may reach one changed
helper. Coverage uses distinct changed identifiers, and review state belongs to
the node rather than each occurrence. This preserves relevant context without
requiring separate review marks for the same change.

Implementation: [residuals](../packages/server/src/residuals.ts),
[coverage](../packages/server/src/coverage.ts), and
[session/plan routes](../packages/server/src/routes/sessions.ts).

## Units and flow context

A flow unit names one or more entry points and covers the union of their changed
flow steps. An orphan unit explicitly groups remaining changed items by purpose;
file globs are resolved to eligible orphan identifiers during plan submission.
Merging overlapping flows preserves derivable membership. Arbitrary sub-flow
splitting and nested units are not supported.

Flow trees show a depth-first path through static call relationships. Relevance
is computed backwards from changed nodes: off-path callees provide one hop of
context without recursively expanding their subtrees. With relevance pruning,
the step-count cap applies to off-path context. The current depth limit still
stops traversal, including relevant paths; missing flow membership is handled by
the coverage fallback rather than a promise of unlimited traversal. Cycle guards
avoid looping through ancestors, while a shared callee may appear under several
callers.

Tests are supporting evidence rather than execution-flow steps. An entry's
reasons and confidence explain why the provider selected it, not whether the
flow is complete or the feature is safe. The test chip reports discovered
relationships, not measured test coverage.

Implementation: [flow traversal](../packages/server/src/graph/flow-tree.ts).

## Attachments

Tests, file residuals, and definitions can belong with an already planned change
even when no execution flow reaches them. The server derives attachments when a
plan is submitted and persists them on its units. This gives the browser, CLI,
and coverage calculations the same ownership decisions. Deriving on every read
would risk different consumers or a fresh index reshuffling the plan mid-review.

Only changed items outside explicit plan coverage are candidates. Explicit
membership takes precedence, and parents must already be covered: attachments
cannot recursively become parents. Four rules run in order; the first match wins:

1. **Test edges:** attach a test under the first exercised covered node in walk
   order. Other units exercising it receive non-counting references.
2. **Same file:** attach under the first covered node in the item's file.
3. **Required by:** attach under the first covered consumer of the item's file.
4. **Test imports:** for remaining tests, choose a covered subject their file
   imports. Matching subject basenames outrank other candidates; type-only
   imports qualify only with that name match. Walk order breaks remaining ties.

Counted attachments enter coverage, unit progress, and the walk immediately after
their parent. Non-counting references are navigation aids and add no review work.
Nodes that match no rule remain visible as unassigned. Replacing a plan derives
attachments again; merely reading a plan does not. This applies equally to
mechanical and agent-authored plans.

The file-dependency relation is provider-optional; without it, the rules that
need that evidence find no candidates. File-level matches are heuristics and do
not establish that a test exercises a particular behavior. Explicit orphan-unit
membership is available when grouping by hand is more appropriate.

Implementation: [attachment rules](../packages/server/src/attach.ts).

## Walk and review state

The walk orders units by position, flow members by tree order, and orphan members
by their displayed directory/file grouping. File residuals follow the associated
file's first non-residual item. Counted attachments follow their parent. Only
changed nodes enter the walk, with the first occurrence winning across units.
Next/previous wrap around; next-unreviewed skips nodes already marked reviewed.

The reviewer can explore unchanged callers/callees and return to the walk. UI
position and layout are local browser state; the durable review ledger is in the
server. Renaming or reordering units does not reset node marks. A plan reorder
does not itself rerun attachment derivation.

Node states distinguish unreviewed, reviewed without comments, and reviewed with
comments. Adding a node comment marks it reviewed-commented. Marking a node
reviewed cannot conceal existing comments, and deleting its final comment moves
it back to reviewed-clean. Review-wide notes have no node anchor and do not mark
nodes reviewed. A mark records a human action, not correctness or approval to
merge.

Implementation: [walk order](../packages/web/src/walk-order.ts),
[comment routes](../packages/server/src/routes/comments.ts), and
[node routes](../packages/server/src/routes/nodes.ts).

## Comment anchors and export

A node comment may optionally anchor a line range. Anchors store actual file
line numbers and old/new sides, not display-row indexes. Both endpoints must
resolve to changed lines in the node's current server-generated diff; range order
follows diff-row order and may cross old/new sides. Context rows can occur inside
the range. An invalid anchor is rejected rather than silently moved or reduced
to a whole-node comment.

The server derives a bounded snippet from the selected range, or from the node
diff for an unanchored comment. Editing comment text preserves the anchor and
snippet. Export derives structural context from stored session edges and keeps
multiple comments as separate ordered entries. File coordinates support external
GitHub mapping; export does not publish a review or relocate comments across
revisions. A stale session must be recreated before continuing the review.

See [comment export](cli-and-configuration.md#comment-export) for fields and
[diff/anchor implementation](../packages/server/src/diff.ts) for validation.

## Plan narratives

The optional session overview describes the overall change; unit rationales
explain how each unit contributes to it. The agent combines available stated
intent with observed changes. Missing PR context does not block planning.

Narratives describe purpose and relationships without declaring correctness.
This helps orient the reviewer without turning an agent-authored explanation
into an apparent review verdict. The server stores opaque text and the UI labels
its origin as **from plan**. Mechanical plans work without narratives.

Every plan submission replaces the overview; omitting it clears the old text.
Units and their rationales are also replaced, avoiding a stale explanation on a
new plan. The overview is available in the UI, status, and comment export.

## Scope and future direction

Review-unit nesting, message-flow tracing, immutable source snapshots, automatic
comment relocation, and an apply-fix/re-review loop are not current contracts.
See [review experience direction](review-experience-direction.md) for product
proposals and [indexing follow-ups](indexing-follow-ups.md) for narrower technical
ideas. Those documents do not promise implementation or a schedule.
