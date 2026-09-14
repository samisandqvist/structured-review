# C# support via scip-dotnet — design

Status: approved design, not yet implemented. Written 2026-09-14 from a
throwaway feasibility spike (scip-dotnet 0.2.14, .NET SDK 8.0.131, a
three-project solution fixture: Web API controller, class-library service,
xUnit tests). Nothing from the spike was committed.

Prerequisite landed separately: interface-to-implementation call bridging in
the shared SCIP decoder (see "Interface bridging" below). It is not C#-specific
and benefits Java.

## Goal

Review C# changes with the same flow-based walk that TypeScript, Python and
Java get: method-level nodes, call edges across files, test evidence, and
residuals for anything the indexer cannot place. C# joins as a fifth SCIP
indexer job behind the unchanged `GraphProvider` boundary.

Out of scope: Visual Basic (scip-dotnet supports it; we do not detect or
test it), F#, Razor/Blazor views, source generators beyond what Roslyn
emits into `obj/`, and cross-process traces.

## Evidence from the spike

| Question | Result |
|---|---|
| Indexer | scip-dotnet 0.2.14, a global or local `dotnet tool`; requires .NET SDK 8+ |
| Invocation | `scip-dotnet index <root>.sln --working-directory <root> --output <file> --exclude '**/obj/**'` |
| Restore | Runs `dotnet restore` itself; `--skip-dotnet-restore` available; writes only under `obj/` |
| Speed | ~4 s cold, ~2 s warm on the fixture |
| Input granularity | Pass the `.sln`; a single `.csproj` indexes only that project |
| enclosingRange | **Absent on every definition.** Upstream PR #108 closed unmerged 2026-03-18; nothing on main as of 0.2.14 |
| Symbol shapes | methods `Cls#Name().`, overloads `Name(+1).`, ctor `` Cls#`.ctor`(). ``, property `Hits.`, field `_cache.`, event `Resolved#`, indexer `` `this[]`. `` (refs use `get_Item().`), locals/lambdas/local functions `local N` |
| Namespace descriptor | Only the last namespace segment survives (`Core/ITokenService#` for `Demo.Core`) |
| Call binding | Calls through an interface-typed receiver bind to the interface method; implementations appear only as `is_implementation` relationships |
| Broken build | Exit 0 and an index is still written, including the broken class |
| Generated files | `obj/**/*.g.cs` and AssemblyInfo documents are indexed unless excluded |
| Span fallback | Brace/semicolon matching from the definition line recovered all 9 method nodes and 6 correct call edges with the unchanged graph builder |

## Design

### Root discovery (`roots.ts`)

Add `cs` to `IndexerLanguage`.

- Markers: `*.sln`, `*.slnx`, `*.csproj`. Marker matching today is by exact
  file name; extend `MARKERS` to accept glob-style entries or add a small
  per-language predicate. A `.csproj` root nested under a `.sln` root of the
  same language is dropped by the existing same-language nesting rule, which
  is the behaviour we want (index the solution once).
- Source extension: `.cs`.
- Fingerprint extras: `Directory.Build.props`, `Directory.Build.targets`,
  `Directory.Packages.props`, `global.json`, `NuGet.config`, `packages.lock.json`.
- `rootHasSources` reuses the existing walk; `obj/` and `bin/` must be added
  to its skip list if not already skipped as ignored directories.

### Command resolution (new module `graph/scip-dotnet.ts`)

`resolveScipDotnetCommand(env)` returns `{ argv0, args } | null`, in order:

1. `SCIP_DOTNET_CMD` override, split on whitespace, used verbatim.
2. `scip-dotnet` on `PATH`.
3. `~/.dotnet/tools/scip-dotnet` (the global-tool install location) when
   `DOTNET_CLI_HOME` or `HOME` resolves.
4. `null` — callers degrade with a warning, never silently.

`SCIP_DOTNET_VERSION` is documented for the install hint only; unlike Java
there is no launcher that pins a version at run time.

The user installs the tool themselves: `dotnet tool install --global scip-dotnet`.
The plugin launcher does not install .NET tooling; it only gains the same
degradation message the Java path has. A later iteration may bootstrap a
local tool manifest under the plugin data directory if dogfood shows the
manual step is the main friction.

### Job planning and execution (`scip.ts`)

- `SCIP_LANGS` default becomes `ts,py,java,cs`.
- `planJobs` drops `cs` jobs with a warning when the command resolves to
  null, mirroring Java: "C# indexing skipped for N root(s): scip-dotnet not
  found. Install with `dotnet tool install --global scip-dotnet` (needs .NET
  SDK 8+) or set SCIP_DOTNET_CMD. C# changes appear as residual-only until then."
- `runIndexer` `cs` branch: pick the solution file in the root (prefer
  `.slnx`, then `.sln`, else the single `.csproj`) and run
  `index <solution> --working-directory <absRoot> --output <indexPath> --exclude '**/obj/**' --exclude '**/bin/**'`.
  A root with more than one solution file is an `IndexError` naming them; the
  user resolves it with `SCIP_DOTNET_SOLUTION=<path>` (documented).
- After decoding and before rerooting, call `synthesizeCsharpSpans(docs, absRoot)`
  (below). This is the only C#-specific hook in the orchestration path.
- Degradation differs from Java: a compile error does not fail scip-dotnet,
  so "indexer exit non-zero" stays the only failure signal and the
  `assertIndexNotEmpty` guard stays the only emptiness signal. Partial
  indexes from broken builds are accepted; the review shows fewer nodes and
  more residuals. Document this in `docs/architecture.md` next to the Java
  paragraph.

### Span synthesis (new module `graph/csharp-spans.ts`)

Pure function: `synthesizeCsharpSpans(docs: ScipDocument[], readFile: (rel) => string): ScipDocument[]`.

For each definition occurrence in a `.cs` document whose symbol ends in `).`
(methods, constructors, local-function-free) and lacks `enclosingRange`, set
`enclosingRange = [startLine, 0, endLine, lastCol]` where `endLine` is found by
scanning from the definition line:

- Track brace depth. The member ends at the `}` that returns depth to zero
  after the first `{`.
- If a `;` is seen at depth zero before any `{`, the member ends there
  (expression-bodied `=> ...;`, abstract/interface/partial/extern members).
- Skip braces and semicolons inside `//` and `/* */` comments, regular strings,
  verbatim `@"..."` strings, raw `"""..."""` strings, char literals, and
  interpolation holes only as far as depth tracking needs (a `{` inside an
  interpolated string opens a hole that its `}` closes; net zero).
- Preprocessor lines (`#if`, `#region`, …) are skipped whole.
- Attributes on preceding lines are not part of the span; the SCIP `range`
  starts at the identifier line, which is what we use.

Definitions that already carry `enclosingRange` are left untouched, so the
module becomes a no-op if upstream ships ranges. Properties, fields, events
and indexers never receive a span and therefore never become nodes, which
keeps the Java-style node filter unnecessary for C#.

Unit tests are string-based and cover: block body, expression body,
interface member, nested braces, braces in strings/comments/raw strings,
interpolated string holes, `#if` blocks, and a definition on the last line.

### Decoder deltas (`scip.ts`)

- `labelOf`: label `` Cls#`.ctor`(). `` with the class name, beside the Java
  `<init>` case.
- Namespace collisions: symbols like `Models/Order#` can collide across
  namespaces. The graph is keyed by symbol, so two colliding types merge into
  one node set. Accept for v1 and log a warning when a definition symbol is
  seen in two files; revisit if dogfood shows real collisions.
- No other decoder changes. Interface bridging is already in place.

### Heuristics

- `isTestFile` (`util.ts`): add `/(Tests?|Specs?)\.cs$/` and
  `/(^|\/)[^/]+\.(Tests?|Specs?)\//` (project-folder convention).
- Entry evidence (`entry-points.ts`): add `csharpEntryReasons` recognising
  `[HttpGet]`/`[HttpPost]`/…/`[Route]` attributes on the preceding lines
  (controller actions), `static ... Main(`, and minimal-API `Map*` lambdas
  only when a configured entry names them. Never probe `export` on `.cs`
  files, as already done for Python.

### Fingerprints and caching

`languagePathspecs("cs", root)` covers `.cs`, the markers and the extras
above. `obj/` and `bin/` are ignored by Git in ordinary repositories and so
never enter the fingerprint; a repository that tracks them would
over-invalidate, which is acceptable.

### Plugin, docs, CI

- Launcher: no bootstrap; add the degradation hint. Rebuild both plugin
  bundles (`pnpm build && pnpm build:plugin`).
- Docs: `AGENTS.md` graph-provider paragraph, `docs/architecture.md` (indexers,
  degradation), `docs/cli-and-configuration.md` (`SCIP_DOTNET_CMD`,
  `SCIP_DOTNET_SOLUTION`, `SCIP_LANGS`), generated SKILL.md.
- CI: `actions/setup-dotnet` pinned by SHA, `dotnet tool install --global scip-dotnet`
  in the ordinary job, one real integration test over a two-project fixture
  (skipped locally when the tool is absent, like Java). Add the tool to the
  security workflow's "outside the pnpm advisory inventory" note in
  `docs/harness.md`.

### Testing

- Unit: span synthesis (string cases above), command resolution (override,
  PATH, tools dir, null), root discovery for sln/csproj nesting, `isTestFile`
  additions, `labelOf` ctor case.
- Integration: one slow test indexing a fixture with a controller calling an
  interface whose implementation lives in another project, asserting method
  nodes exist, the controller→implementation edge exists via bridging, and
  the test method attaches as evidence.
- Harness: every new file must meet the 95/90 coverage floors and the
  complexity limits (15 cyclomatic, nesting 4, 80 lines). Keep the scanner
  as small state-machine helpers rather than one function.

## Estimate

Two to four days, matching the Java integration, since bridging is already
landed. The span module is the only genuinely new piece and holds all the
C#-specific risk.

## Open questions

- Should the launcher bootstrap a local tool manifest instead of asking users
  to install globally? Decide after first dogfood.
- Multi-target-framework projects: scip-dotnet appears to index one
  compilation per project; confirm whether `net8.0;net9.0` produces
  duplicate definitions and dedupe if so.
- Whether to surface "index built from a project with compile errors" as an
  `indexWarnings` entry. scip-dotnet's log output would need parsing; skip
  unless dogfood asks for it.
