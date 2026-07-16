# scip-java spike — findings (Phase 3 gate)

Decision-gate probe for Phase 4 of the polyglot roadmap
(`docs/superpowers/plans/2026-07-15-polyglot-provider-roadmap.md`), run
2026-07-16 against `aivo/introspector` (Spring Boot, Maven, 155 Java files)
on the `introspector-obo` branch — the same diff the Phase 4 checkpoint will
dogfood.

**Gate verdict: PASS — proceed with Phase 4 at the original ~2–4 day
estimate.** `enclosingRange` is present on method definitions and call
references are method-granular; no span-derivation workaround needed. Two
small, quantified decoder adjustments are required (node filter, `labelOf`),
both listed below.

## How it was run

```bash
# scip-java is NOT in coursier's default app channel (`cs install scip-java`
# fails); launch it by Maven coordinates instead:
cs launch com.sourcegraph:scip-java_2.13:0.12.3 \
  -M com.sourcegraph.scip_java.ScipJava -- index --output introspector.scip
# then decode with the server's own scip.proto + protobufjs pipeline and
# replicate buildGraphFromIndex's node/edge derivation.
```

- JDK 21 + Maven 3.6.3 (already on this machine). scip-java wraps the full
  `mvn compile` (it observes javac via a compiler plugin).
- **Wall-clock: 13 s** for index + compile on a warm `target/` and warm
  dependency cache. The roadmap feared minutes; compile time dominates and
  scales with the project's own build, not with scip-java. A cold first run
  additionally downloads Maven deps + the scip-java artifacts (one-time,
  minutes).

## Gate questions

| Question | Answer |
|---|---|
| Method definitions carry `enclosingRange`? | **Yes** — 1661/1779 global defs, incl. all 806 method-shaped defs |
| Symbols follow `Class#method().`? | **Yes** — `… ViewService#createView().`; overloads get `(+N).`; constructors `` `<init>`(). `` |
| First-party call references at method granularity? | **Yes** — 2181 call edges across 675 callers (method-filtered: 364 callers), e.g. `ViewController#createView()` → `ViewService#createView()` |
| Broken build → clear error? Partial index? | **Exit 1, javac error with file:line, and no index file written at all.** No partial-index ambiguity; maps directly onto the existing `IndexError` non-zero-exit path |
| Merge collision risk? | None — symbols prefixed `semanticdb maven maven/<groupId>/<artifactId> <version>`, disjoint from `scip-typescript npm …` and `scip-python python …` |
| Document paths | Relative to the project root (`src/main/java/…`) — `rerootDocuments` works unchanged |

## Sharp edges found (Phase 4 must handle both)

**1. `enclosingRange` is NOT function-only in scip-java — fields and types
carry it too.** Defs with `enclosingRange` by symbol shape:

| shape | count | meaning |
|---|---|---|
| `…method().` / `…(+N).` | 806 | methods/constructors — the nodes we want |
| `…field.` (term) | 670 | fields, enum constants — **noise** |
| `…Type#` | 176 | classes/interfaces — already dropped by the existing `[#/]$` filter |

Phase 1's "has `enclosingRange` ⇒ function/method" assumption is
scip-typescript-specific. Without a filter, 670 field defs become graph
nodes and field reads become call edges (`createView() → viewService`
field-noise alongside the real `→ ViewService#createView()`). **Fix: for
Java documents, additionally require the symbol to end with `).`** (method
descriptor). One line in the node loop; dropping field nodes also drops the
field-read edges automatically.

**2. `labelOf` fails on 81/806 method-like symbols** — all constructor and
overload descriptors: `` `<init>`(). `` (backticked, angle-bracketed) and
`(+N).` (overload disambiguator) don't match the `().`-strip + trailing
identifier regex, so those defs are silently dropped today. **Fix:
generalize the suffix strip from `/\(\)\.$/` to `/\([^)]*\)\.$/` and map a
`` `<init>` `` tail to the enclosing class name** (a constructor labeled
`EntityNotFoundException` is also better UX than `<init>`).

## Phase 4 checkpoint preview (OBO branch)

Replicating the graph derivation with the `).` node filter against the
`introspector-obo` diff (19 changed Java files vs main):

- 17/19 changed files contain method nodes (151 nodes total; the other two
  are annotation/field-only DTO changes → residual, correctly).
- Changed controllers form 20 controller → service/helper call edges,
  including `IntrospectionController#introspect()` →
  `DbAccessTokenHelper#resolveDbAccessToken()` and →
  `IntrospectionService#introspect()` — exactly the OBO review chains this
  roadmap exists to surface.
- Test files (`RequireUserTokenControllerTest.java`, `src/test/java/**`)
  match the Phase 2 `isTestFile` patterns → TESTED_BY edges, not flow steps.

## Toolchain / packaging notes (feeds the plugin release)

- Distribution: no self-contained binary; the reliable path is coursier by
  Maven coordinates (command above). Pin the version (`0.12.3` probed).
  `cs install scip-java` does **not** work (not in the default app channel) —
  the plugin's "install scip-java via X" error message must give the
  `cs launch` form or an install channel, not `cs install scip-java`.
- Requirements on PATH: `cs` (coursier) + JDK + Maven — matches the
  roadmap's "detect, else degrade per-language with a visible warning".
- Cache is load-bearing as predicted: 13 s warm-compile per session would be
  felt; the Phase 1 per-root fingerprint (now language-scoped, with
  `FINGERPRINT_EXTRAS` covering `pom.xml` via MARKERS) makes the no-change
  path free. Consider adding `pom.xml` lockfile-ish inputs
  (`.mvn/`, `settings.xml`) to java `FINGERPRINT_EXTRAS` in Phase 4.

## Phase 4 adjustments (delta to the roadmap's plan)

1. Java node rule: require `/\)\.$/` symbol suffix (drops 670 field/enum + 9
   misc defs).
2. `labelOf`: `/\([^)]*\)\.$/` strip + `<init>` → class-name label.
3. Indexer job: `cs launch com.sourcegraph:scip-java_2.13:<pinned> -M
   com.sourcegraph.scip_java.ScipJava -- index --output <tmp>` per
   Maven/Gradle root, cwd = root; detect `cs`/JDK/Maven and degrade with an
   actionable message when missing.
4. Everything else (re-rooting, merge, cache, IndexError, isTestFile,
   `#`-kind heuristic) works unchanged — verified against this index.
