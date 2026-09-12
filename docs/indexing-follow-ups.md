# Indexing follow-ups

These are candidate investigations retained from earlier planning, checked
against current source on 2026-09-12. They are not scheduled work or claims of
supported behavior. Current behavior is described in [architecture](architecture.md)
and [CLI/configuration](cli-and-configuration.md); broader product proposals live
in [review experience direction](review-experience-direction.md).

| Candidate | Current evidence or limitation | Useful next investigation |
| --- | --- | --- |
| Rust support | Root discovery and runners support `ts`, `py`, and `java`; no Rust job exists | Probe a version-pinned Rust SCIP producer on a synthetic fixture; verify spans, symbols, first-party references, build behavior, and toolchain failure before designing integration |
| Java framework entry evidence | Entry detection has Python decorator/main-guard heuristics and TypeScript export evidence; Java can use graph roots and explicit configuration | Test annotation-based HTTP/job/event entry detection against representative fixtures before adding reasons or scores |
| Multiline Python decorators | Detection is line-oriented and can miss decorators when the definition span does not expose the decorator start | Add evidence fixtures for multiline decorator calls and aliases, then decide whether a broader parser is justified |
| More selective cache invalidation | Per-job working-tree inputs are language-scoped, but the committed subtree hash can change for unrelated languages | Measure avoidable reindexing before replacing that component with a hash of language-relevant committed files |
| External index inputs | User-global Maven configuration, JDK changes, and other external toolchain state are not fully represented in cache keys | Establish which external changes need explicit invalidation or a restart/bypass instruction |
| Gradle validation | Discovery recognizes Gradle markers; Java launch delegates build handling to the external indexer | Add a real Gradle fixture and toolchain matrix before asserting parity with the Maven integration path |
| Attachment overrides | File-level heuristics may choose an unhelpful parent; explicit plan membership currently takes precedence | Gather misattachment examples before adding pin/exclude UI or a new persistence contract |

Implementation references: [root discovery](../packages/server/src/graph/roots.ts),
[entry evidence](../packages/server/src/graph/entry-points.ts),
[indexer orchestration](../packages/server/src/graph/scip.ts),
[fingerprints](../packages/server/src/diff.ts), and
[attachment rules](../packages/server/src/attach.ts).
