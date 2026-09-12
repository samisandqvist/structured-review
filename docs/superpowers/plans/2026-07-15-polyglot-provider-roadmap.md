# Polyglot Graph Provider — Roadmap (rough plan)

> Project, branch, and application identifiers in this historical note have been anonymized.

**Status:** roadmap, pre-implementation. Each phase gets its own detailed
SDD plan (writing-plans → subagent-driven-development) when we start it.
Ordering agreed 2026-07-15: orchestration + Python first, heuristics second,
Java last behind a spike gate.

**Goal:** flow-ordered review for Java and Python changes (sample-project:
`example-service/` is Maven/Java, `mcp/*` is Python, plus existing TS), by
running one SCIP indexer per language root and merging the indexes into the
one call graph the rest of the product already consumes.

**Why this is tractable:** verified empirically 2026-07-15 — `scip-python`
indexed `sample-project/mcp/example-connector` in ~1 s and our own decoder
(`scip.proto` + protobufjs) confirmed function/method definitions carry
`enclosingRange` (our function detector) with `().`-suffixed symbols, i.e.
`buildGraphFromIndex` consumes it essentially unchanged. SCIP symbols are
namespaced by scheme+package (`scip-python python example-connector …`), so
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
- **Checkpoint:** re-run the sample-project `sample-feature` dogfood — the Python
  MCP half of that diff (config → backend_client → server) should produce
  affected flows and relations while Java remains residual-only.

**Phase 1 checkpoint (2026-07-16): PASSED.** Dogfood on sample-project
`sample-feature` vs main: discovery found 15 language roots (5 ts, 10 py),
all indexed and merged (~20 s cold). The Python MCP half produced 5 affected
flows — `main → config.from_env → create_server → _build_token_provider
→ exchange` plus the four MCP tools (`executeSql` etc.) each flowing through
`backend_client` into shared `_get_headers` — and the plan UI rendered flow
tracks, entry evidence, and node-scoped Python diffs (screenshot:
`phase1-python-flows.png`). All 19 Java files landed residual-only, grouped
into orphan units. Cache split verified: touching one Python file re-indexed
only `mcp/example-connector` (2.4 s warm session vs 20 s cold), the other 14
roots served from the per-root cache. Full plan coverage 47/47, zero
unassigned.

**Known limitation (final review, 2026-07-16):** the per-root cache split
degrades when a language root sits at `""` (repo root) above nested roots of
another language — `subtreeFingerprint("")` hashes `git diff HEAD -- .` (the
whole repo), so editing a nested Python file also moves the repo-root TS
job's key and re-indexes TS even though nothing TS-relevant changed. This is
an efficiency limitation, not a correctness bug (the cache never serves stale
data — it just over-invalidates). The known remedy, if it bites in practice,
is a language-scoped subtree fingerprint that filters `git diff` /
untracked-file listing by the job's language `SOURCE_EXTS` instead of the
raw pathspec; candidate for Phase 2.

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
- Index `sample-project/example-service` (standard Maven project). Measure wall-clock —
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

**Phase 3 gate (2026-07-16): PASSED** — see
`docs/scip-java-spike-findings.md`. enclosingRange present on all 806 method
defs, call refs method-granular (controller → service chains on the sample-feature diff
confirmed), broken build = exit 1 + no index file. 13 s warm index on
example-service (compile-dominated). Two small decoder deltas for Phase 4: Java
node filter (fields also carry enclosingRange — require `).` suffix) and a
labelOf generalization (`(+N).` overloads, backticked `<init>`). Original
~2–4 day Phase 4 estimate stands.

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
- **Checkpoint:** the sample-project sample-feature branch dogfood again — this time the 19
  Java files should form flows (controller → service → example-service →
  policy/helper), which is the review this whole roadmap exists for.

**Phase 4 checkpoint (2026-07-16): PASSED.** Dogfood on sample-project
`sample-feature` vs main: 235 flows (51 Java, 37 Python), including
`introspect → resolveJdbcUrl → resolveToken → performDatabase-
Introspection` — the sample-feature chain itself. 17/19 changed Java files carry method
nodes (2 field-only DTOs correctly residual); constructor labels render as
class names; node-scoped Java diffs work (screenshot:
`p4-java-flow-tracks.png`, `p4-java-node-diff.png`). 27 s cold across all
three languages, 1.9 s warm. Degradation verified live: server with `cs`
stripped from PATH still creates the session (19 s), persists the exact
install-hint warning, indexes 0 Java nodes, and all 19 Java files appear as
residual pseudo-nodes; PlanView shows the amber banner
(`p4-degradation-banner.png`). Python flows unchanged (Phase 1 regression
check).

## Explicitly out of scope (this roadmap)

- LSP refinement (P3 — only if SCIP accuracy gaps show up in practice).
- Message-flow providers, team/hosted workflows (P3).
- v2 entry-evidence detectors are optional scope inside Phase 2, first to
  slip if phases run long.

## Rough total

~1–1.5 weeks of implementation across phases 1–4, phased so each lands
independently: after Phase 1 Python reviews work end-to-end; Phases 2–4
each improve quality without blocking use. Plugin packaging and Phase 5
(Rust) add ~3–5 days on top — see the plugin-release section below.

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

---

## Agent CLI — set up and harvest reviews without curl/SQL (~0.5–1 day, before plugin packaging)

Motivation (2026-07-16 Phase 4 dogfood): driving a review session as the
agent currently means hand-rolling `curl` against the HTTP API to create the
session and build a plan, and reading the SQLite file directly to see the
user's review output (comments, reviewed states). That works but is
error-prone, undiscoverable, and exactly the part the walkthrough skill
scripts — it deserves a stable command surface.

**Shape:** a small Node CLI (extend `packages/skill/src`, e.g. `crw <cmd>`),
JSON on stdout for agent consumption, human-readable with `--pretty`. Thin
wrapper over the existing HTTP API (and server lifecycle) — no new server
endpoints unless a gap shows up; notably NO direct SQLite access, so it
stays correct across schema migrations.

Setup side:

- `crw serve [--repo <path>] [--port N]` — ensure the hub is running against
  a repo (start if needed, reuse if healthy), print base URL + PID.
- `crw session create --branch <b> --base <ref>` — create a session; print
  session id, UI URL (`…/?session=<id>`), node/flow counts, and
  `indexWarnings` (the agent must relay degradation warnings to the user).
- `crw plan --session <id> --auto` — mechanical plan: top flow entries per
  language + auto orphans (what the Phase 4 dogfood did by hand);
  `crw plan --session <id> --units <file.json>` for an LLM-authored plan.

Harvest side (act on the user's review output):

- `crw status --session <id>` — coverage, per-unit reviewed/total,
  remaining-unreviewed node list; stale flag.
- `crw comments --session <id>` — all comments with node label, file,
  anchor (start/end line + side), hunk snippet, and review status —
  GitHub-mappable, ready for the skill's wrap-up (PR feedback / report).
- `crw wait --session <id> [--until reviewed|commented]` — optional: poll
  until review activity settles, for "tell me when Sami is done" flows.

Feeds plugin packaging directly: packaging task 3 (skill paths → built CLI)
ships this same binary via `${CLAUDE_PLUGIN_ROOT}`, and the skill.md shrinks
to "run `crw …`" invocations.

## Unassigned-changes revisit — attach tests and uncalled types to their context (design + implement, after the CLI, before/alongside plugin packaging)

Motivation (2026-07-16 Phase 4 dogfood): the sample-feature session planned 26/100
changes into flow units; the other 74 landed in "Unassigned changes" — and
most of them are not orphans in any meaningful sense. They fall into three
groups with obvious homes:

1. **Changed tests** (the bulk: `*Test.java` methods, `test_*.py`
   functions). Flows exclude tests by design (test callers are TESTED_BY
   evidence, not flow steps), so changed tests always land unassigned today
   even when the code they exercise sits in a flow unit. Option: nest them
   as green sub-nodes "under" the production node they exercise — the
   opposite of call-graph direction, but it puts the test in the same
   mental context as the code under review ("here's the change, here's how
   its tests changed"). The data already exists: TESTED_BY edges are in the
   subgraph, and the UI already styles tests green (the per-unit
   `tests n/m` chip counts them).
2. **Uncalled types/DTOs** (changed nodes or residuals with no call
   edges — `DirectSqlRequestDto`, `UpdateRequireUserTokenDto.java`).
   Option: nest them under the node/file that requires/imports them. The
   index has this: SCIP import occurrences (ROLE_IMPORT) and references to
   type symbols (`…#`) are currently *dropped* in `buildGraphFromIndex` —
   a "required-by" relation derived from them would attach a DTO to the
   controller/service that consumes it.
3. **Module-scope residuals** of files whose methods ARE in flows
   (`ExampleService.java (module scope)`): could attach to the same
   unit as the file's flow nodes (same-file affinity — no new index data
   needed).

Design questions to settle first (this item starts with a brainstorm, not
code): does "assigned" mean walk-order membership (reviewed inside the
unit's walk) or just visual nesting with coverage credit? Do nested tests
count toward the unit's reviewed n/m or keep their own ledger? Ordering
within a node: code first, then its tests? What happens when a test
exercises nodes in two different units (first unit in plan order wins,
duplicate as reference, or reviewer choice)? And how much should the
mechanical `crw plan --auto` exploit this vs. leaving it to LLM-authored
plans?

Not scoped yet — needs its own brainstorm → plan cycle. Rough guess ~1–2
days for options 1+3 (data exists), option 2 adds decoder work (keep the
dropped import/type references, file-level "requires" edges).

## Release as a Claude Code plugin (findings, 2026-07-16)

Assessed against current plugin docs
(https://code.claude.com/docs/en/plugins-reference.md). Verdict: the
architecture already fits the plugin model — packaging is ~2–4 days on top
of this roadmap, not a rewrite.

**Why it fits:**

- A plugin bundles skills, MCP servers, hooks, and executables; distributed
  via a git-repo marketplace (`/plugin marketplace add <user>/<repo>`,
  private repos work). `packages/skill/skill.md` is already a plugin skill
  in all but directory layout.
- scip-typescript resolves from `node_modules` (`graph/scip.ts`) and
  scip-python ships the same way — **TS and Python support bundle for
  free**, no user-installed toolchain.
- Long-lived local HTTP server + browser UI is an accepted pattern: a
  skill/MCP tool starts the server and returns a localhost URL; server
  lifetime is tied to the Claude Code session, matching our session model.
- Java is the only heavy toolchain (JVM + coursier + build-wrap, can't be
  bundled). Precedent: official LSP plugins require the binary
  pre-installed. Phase 4's "detect on PATH, degrade per-language with a
  visible warning" is exactly the plugin-required behavior.

**Strategic implication:** per-language graceful degradation and session
diagnostics (open question 3 above) stop being polish and become
release-blocking — plugin users' toolchains are uncontrolled, and a missing
JVM must read as "install scip-java via X", not a mysteriously flow-less
plan.

**Packaging tasks (new, on top of phases 1–4):**

1. Publish the server to npm and launch via `npx @crw/server` (cleanest),
   or a `SessionStart` hook installing into `${CLAUDE_PLUGIN_DATA}`.
   Caveat: `better-sqlite3` is a native module — prebuilds cover common
   platforms; consider migrating to Node 22's built-in `node:sqlite` to
   remove the native-compile risk entirely.
2. Serve the built web UI statically from the server (dev currently runs
   Vite separately).
3. Rework skill paths: `skill.md` invokes `npx tsx packages/skill/src/…`
   (repo-relative source) — must become built JS via
   `${CLAUDE_PLUGIN_ROOT}` or a published CLI. Add `plugin.json` +
   marketplace skeleton.
4. Relocate state: SQLite DB and index caches into
   `${CLAUDE_PLUGIN_DATA}` (persists across plugin updates), not the
   plugin dir or the reviewed repo.

## Phase 5 — Rust via rust-analyzer (spike + integration)

Lighter than Java: **rust-analyzer has a built-in `scip` subcommand**
(`rust-analyzer scip .` emits `index.scip`) — no separate indexer to
acquire, single static binary users typically have via
`rustup component add rust-analyzer`. Same "external toolchain" class as
Java but no JVM/coursier/build-wrap. Consider running its spike alongside
or before the Java gate (Phase 3).

- **Spike (~half day, same probe as Phase 3):** do definitions carry
  `enclosingRange`? Do symbols parse in `labelOf`? First-party call
  references at fn granularity? (Not verified — rust-analyzer isn't
  installed on this machine; `rustup component add rust-analyzer` first.)
- **Integration:** one more indexer job on Phase 1 orchestration — root
  detection = `Cargo.toml`, skip nested workspace members; PATH detection
  + per-language degradation like scip-java.
- **Heuristics (Phase 2 additions):** `*_test.rs`, `tests/`,
  `#[cfg(test)]`; exclude `target/`.
