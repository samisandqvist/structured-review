# Polyglot Graph Provider — Roadmap (rough plan)

**Status:** roadmap, pre-implementation. Each phase gets its own detailed
SDD plan (writing-plans → subagent-driven-development) when we start it.
Ordering agreed 2026-07-15: orchestration + Python first, heuristics second,
Java last behind a spike gate.

**Goal:** flow-ordered review for Java and Python changes (aivo:
`introspector/` is Maven/Java, `mcp/*` is Python, plus existing TS), by
running one SCIP indexer per language root and merging the indexes into the
one call graph the rest of the product already consumes.

**Why this is tractable:** verified empirically 2026-07-15 — `scip-python`
indexed `aivo/mcp/introspector-jdbc` in ~1 s and our own decoder
(`scip.proto` + protobufjs) confirmed function/method definitions carry
`enclosingRange` (our function detector) with `().`-suffixed symbols, i.e.
`buildGraphFromIndex` consumes it essentially unchanged. SCIP symbols are
namespaced by scheme+package (`scip-python python introspector-jdbc …`), so
merging indexes is document concatenation with no collision risk.

---

## Phase 1 — Multi-index orchestration + scip-python (~3–4 days)

The architectural piece; Python rides along as the cheapest second indexer.

- **Language-root discovery** in the scip provider: walk the repo for
  `tsconfig.json`/`package.json` (ts), `pyproject.toml`/`setup.py`/
  `requirements.txt` (py), `pom.xml`/`build.gradle` (java — detected now,
  used in Phase 4). One "indexer job" per root; skip roots nested inside
  another root of the same language. Env/config override for
  include/exclude (monorepos will need it eventually; keep v1 simple:
  auto-detect + `SCIP_LANGS=ts,py` style filter).
- **Run scip-python per Python root** (`@sourcegraph/scip-python` as a
  server dependency — same acquisition path as scip-typescript; shell out
  with `--output`). Note: resolves best with the project's deps installed;
  first-party edges (what we need) worked without them in the probe.
- **Merge indexes before graph-building:** concatenate decoded documents
  from all jobs, feed the union to `buildGraphFromIndex` (verify it is
  index-shape-agnostic; file paths in documents are relative to each
  indexer's root — must be re-rooted to repo-relative before merging.
  This is the one known sharp edge in the merge).
- **Cache per (indexer, root, content-fingerprint)** — extend the existing
  fingerprint cache so editing a Python file doesn't re-index TS and vice
  versa. Fingerprint scope: the language root's files, not the whole repo
  (open question: cheap way to scope `git diff HEAD` to a subtree — likely
  `git diff HEAD -- <root>`).
- **Fail loudly:** an indexer that exits non-zero or produces an empty
  index for a root that plainly has source files should surface in session
  creation (extend the GitError-style phase errors with an `index` phase),
  not silently produce an orphan-only plan. Silent degradation is exactly
  what the P0 wave stamped out for git.
- **Checkpoint:** re-run the aivo `introspector-obo` dogfood — the Python
  MCP half of that diff (config → backend_client → server) should produce
  affected flows and relations while Java remains residual-only.

## Phase 2 — Per-language heuristics (~1–2 days)

Two TS-chauvinist functions gain language variants, keyed off file
extension / root language:

- **`isTestFile`** (`util.ts`): add `src/test/java/**`, `*Test.java`,
  `*IT.java` (java); `test_*.py`, `*_test.py`, `tests/`, `conftest.py`
  (py). Keep the TS patterns.
- **Entry evidence** (`graph/entry-points.ts`): `isExportedAt` reads the
  `export` keyword — TS-only. v1 (this phase): Java/Python entries fall
  back to graph-root 0.4 + `.crw-entry-points.json` (already
  language-neutral, ships today). v2 (separate, optional, can slip):
  detector variants that are *stronger* than TS's — Java annotations
  (`@RestController`/`@GetMapping` → http-route, `@Scheduled`/
  `@KafkaListener` → job/event) and Python decorators (`@app.route`,
  `@mcp.tool`) / `if __name__ == "__main__"` → cli. These realize the
  findings doc's original detector list; do them only after Phase 1 proves
  flows on real polyglot diffs.
- Audit other lurking TS assumptions: `labelOf` symbol parsing (probe says
  fine for py), the `#`-suffix method detection in `routes/changes.ts`
  kind heuristic, snippet/signature reading (language-agnostic already).

## Phase 3 — scip-java spike (gate, ~half a day)

Decision gate before committing to Phase 4. Produce a short findings note
(same style as `docs/scip-vs-crg-findings.md`):

- Install scip-java (coursier `cs install scip-java`, or released
  launcher); JDK 21 + Maven 3.6.3 already on this machine.
- Index `aivo/introspector` (standard Maven project). Measure wall-clock —
  indexing wraps the compile, so expect minutes, not seconds.
- Run the same decoder probe: do method definitions carry
  `enclosingRange`? Do symbols follow the `Class#method().` shape? Are
  first-party call references present at method granularity?
- Check failure modes: broken build → clear error we can surface? partial
  index?
- **Gate:** if enclosingRange is absent or call references are
  class-granular only, Phase 4 needs a span-derivation workaround (e.g.
  spanning definition occurrences per file) — re-estimate before starting;
  otherwise proceed.

## Phase 4 — scip-java integration (~2–4 days, after the gate)

- New indexer job type on the Phase 1 orchestration: per Maven/Gradle
  root, run scip-java, merge like the others.
- Toolchain acquisition is the novel part (JVM tool, not npm): detect
  `scip-java` on PATH, else document install; clear actionable error when
  missing (a TS/Python-only session must still work — degrade per-language
  with a visible warning in session diagnostics, not silently).
- Cache is load-bearing here (compile-time indexing): per-root fingerprint
  from Phase 1 must make the no-change path free.
- Test-file heuristics from Phase 2 already cover Java.
- **Checkpoint:** the aivo OBO branch dogfood again — this time the 19
  Java files should form flows (controller → service → introspector →
  policy/helper), which is the review this whole roadmap exists for.

## Explicitly out of scope (this roadmap)

- LSP refinement (P3 — only if SCIP accuracy gaps show up in practice).
- Message-flow providers, team/hosted workflows (P3).
- v2 entry-evidence detectors are optional scope inside Phase 2, first to
  slip if phases run long.

## Rough total

~1–1.5 weeks of implementation across phases 1–4, phased so each lands
independently: after Phase 1 Python reviews work end-to-end; Phases 2–4
each improve quality without blocking use.

## Open questions to resolve during detailed planning

1. Subtree-scoped fingerprints: `git diff HEAD -- <root>` + untracked files
   under root — enough for cache correctness?
2. Where language roots overlap (a `package.json` at repo root above a
   Python service): precedence and dedup rules.
3. Session diagnostics: Phase 1's "fail loudly" wants a place to report
   per-root indexer status — this overlaps the deferred "provider/session
   diagnostics" P2 item; consider folding a minimal version in.
4. scip-python and virtualenvs: do we document "install deps first" or
   auto-detect `.venv` and pass it through?
