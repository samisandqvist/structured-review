# Component Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the component map: SCIP evidence for an LLM, a hub that resolves and checks an LLM-written component model against the index, a `component-map` skill and a nested UML component diagram page in the web UI.

**Architecture:** The SCIP provider exposes a symbol-level reference index (after a decoder fix for namespace members). Pure modules under `packages/server/src/map/` parse the model, assign files to components, resolve bindings and call sites, derive delegation and evaluate fidelity rules 1–7. Routes under `/api/sessions/:id/map` serve evidence, dry-run checks and a stored map; `srev map …` wraps them. The web app gets a map page that builds one level at a time (pure), lays it out with elkjs in two passes and renders SVG with React.

**Tech Stack:** TypeScript strict, Hono, node:sqlite, zod, Vitest, React 19, TanStack Query, elkjs 0.9.3 (EPL-2.0).

**Spec:** `docs/superpowers/specs/2026-10-26-component-map-design.md`

## Global Constraints

- No reference to the private spike subject (its names, its repository) anywhere in the repo: code, tests, fixtures, docs, commits.
- Docs and comments describe current state only; no em dashes; no "X, not Y" phrasing.
- Mapped languages: TypeScript/JavaScript (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`) and Python (`.py`). Java and C# roots appear as index gaps "not yet mapped".
- Test files (`isTestFile` in `packages/server/src/util.ts`) are never mapped.
- The hub never calls a model.
- New source files: 95% statements/lines/functions, 90% branches; changed lines 95%. Functions: complexity and cognitive complexity ≤ 15, nesting ≤ 4, parameters ≤ 5, ≤ 80 lines (docs/harness.md). Keep Q-ABSTRACTION.
- Dependency-cruiser: no cycles (type imports count), web never imports server/skill, server never imports web/skill.
- elkjs is EPL-2.0: the web build ships its notice and a pointer to its source; `docs/harness.md` records the runtime dependency.
- Plugin bundles regenerate with `pnpm build && pnpm build:plugin`; both skills are generated for Claude Code and Codex.
- Reserved level id `system` (the level above the top components); component ids match `^[a-z0-9][a-z0-9._-]*$` and are not `system`.

## Review Focus

1. A bind entry whose name exists in two provider files: the check reports an ambiguity naming both files and the `file.ts:name` qualified form; it never picks one silently.
2. A reference from a file owned directly by a parent that has parts (an unclaimed file): counted as unattributed and listed with unclaimed files, never dropped silently and never blocking.
3. A model with a cycle in `parent`, a requirer that is not a sibling, or a utility that provides an interface: structural errors from the check, no crash during resolution.
4. A map requested on a hub whose provider has no reference index (stub, CRG): 400 with a clear message.
5. A level whose interfaces have no ports at that level (cross-process interface with external requirers at the system level): the page still lays out and draws the connector.

---

## File Structure

Server (`packages/server/src/`):
- `graph/namespace-members.ts` (create): resolve `local N` member occurrences after a module occurrence.
- `graph/references.ts` (create): build the `ReferenceIndex` from decoded documents.
- `graph/scip.ts` (modify): apply namespace resolution in `buildGraphFromIndex`, keep documents and job languages on `BuiltGraph`, implement `getReferenceIndex()`.
- `graph/provider.ts` (modify): optional `getReferenceIndex?()`.
- `map/model.ts` (create): zod schema, `parseMapModel`.
- `map/ownership.ts` (create): component tree helpers and file ownership.
- `map/bindings.ts` (create): bind-entry resolution.
- `map/resolve.ts` (create): call sites, coverage, delegation, type dependencies.
- `map/check.ts` (create): `checkMap` coordinator producing `ResolvedMap` + `CheckReport`.
- `map/signals.ts` (create): header comments, entry points, registrations.
- `map/evidence.ts` (create): `buildEvidence`.
- `map/types.ts` (create): shared map types.
- `db/schema.ts` (modify): v11 `component_maps`.
- `repo/maps.ts` (create), `routes/map.ts` (create), `app.ts` (modify).

Skill (`packages/skill/`):
- `src/map.ts` (create): HTTP client + pretty printers for `srev map`.
- `src/cli.ts` (modify): `map evidence|check|submit|get`.
- `component-map.md` (create): skill source.

Web (`packages/web/`):
- `src/map/types.ts`, `src/map/levels.ts`, `src/map/layout.ts`, `src/map/measure.ts`, `src/map/MapPage.tsx`, `src/map/MapDiagram.tsx`, `src/map/MapPanel.tsx`, `src/map/usePanZoom.ts` (create).
- `src/App.tsx`, `src/api/client.ts`, `src/api/hooks.ts`, `src/navigation.ts`, `src/styles.css` (modify).
- `public/THIRD-PARTY-NOTICES.txt` (create).

Other: `scripts/build-plugin.mjs`, `docs/component-map.md` (create), `AGENTS.md`, `README.md`, `docs/harness.md`, `knip.json` if needed.

---

### Task 1: Namespace member references in the SCIP decoder

**Files:**
- Create: `packages/server/src/graph/namespace-members.ts`
- Modify: `packages/server/src/graph/scip.ts` (`buildGraphFromIndex`)
- Test: `packages/server/test/namespace-members.test.ts`

**Interfaces:**
- Produces: `resolveNamespaceMembers(documents: NamespaceDocument[], readSource: (file: string) => string | undefined): number` mutating occurrence symbols in place and returning the count recovered. `NamespaceDocument = { file: string; occurrences: ScipOccurrenceLike[] }` with `ScipOccurrenceLike = { range?: number[]; symbol?: string; symbolRoles?: number }`.
- `buildGraphFromIndex(idx, root, readSource?)`: third optional parameter, default reads `join(root, file)` and returns `undefined` on error.

Rule: an occurrence with a `local …` symbol whose range starts on the same line as the previous occurrence (document order sorted by line, column), where the previous occurrence's symbol is a module symbol (ends with `/`, not local) and `prev.endColumn + 1 === occ.startColumn`, and the source character at `prev.endColumn` is `.`, takes the member name from the source line (`line.slice(start, end)`) and resolves it in the module document: first a non-local symbol in that document whose descriptor after the file is `name().`, `name.` or `name#`; otherwise follow `export * from` modules (module occurrences on lines starting with `export *`) recursively with a visited set. Unresolved occurrences keep their local symbol. The module document is found by the file part of the module symbol (`` src/store/`index.ts`/ `` → `src/store/index.ts`).

- [ ] **Step 1: Write failing tests** in `namespace-members.test.ts` with synthetic documents and an in-memory `readSource`:
  - `resolves ns.fn() to the definition the module re-exports` (barrel doc has a reference occurrence to `` src/store/`jobs.ts`/getJob(). `` on an `export { getJob }` line; caller doc has `` src/store/`index.ts`/ `` at [3,8,13] and `local 4` at [3,14,20] with source line `  store.getJob(1);`): symbol becomes the jobs.ts symbol, return value 1.
  - `follows export * chains` (index.ts `export * from "./jobs.js"` with a module occurrence of `` src/store/`jobs.ts`/ ``).
  - `leaves locals that do not follow a module occurrence`, `leaves a local separated by more than a dot`, `leaves an unknown member local`, `survives a missing source file`.
  - In `scip-edge-weight.test.ts` style: `buildGraphFromIndex counts a namespace member call as a call edge` (readSource passed explicitly).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/server/test/namespace-members.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `namespace-members.ts`; call it at the start of `buildGraphFromIndex` on the mapped documents (only for documents whose file has a TS/JS extension).
- [ ] **Step 4: Run** the new test plus `pnpm exec vitest run packages/server/test` → PASS.
- [ ] **Step 5: Commit** `fix(scip): resolve namespace member references through module exports`.

### Task 2: Reference index from the SCIP provider

**Files:**
- Create: `packages/server/src/graph/references.ts`
- Modify: `packages/server/src/graph/scip.ts`, `packages/server/src/graph/provider.ts`
- Test: `packages/server/test/references.test.ts`, extend `packages/server/test/scip-multi.test.ts` or a new real-indexer test `packages/server/test/references-scip.test.ts`

**Interfaces:**
```ts
export type SymbolKind = "function" | "method" | "value" | "field" | "type" | "module" | "other";
export interface SymbolDef { symbol: string; file: string; line: number; name: string; kind: SymbolKind }
export interface SymbolRef { symbol: string; file: string; line: number; caller: string; typeOnly: boolean }
export interface BarrelExport { file: string; exports: { from: string; names: string[] }[] }
export interface ReferenceIndex {
  files: string[];                       // mapped, non-test source files, sorted
  definitions: Map<string, SymbolDef>;   // non-local, mapped-file definitions
  references: SymbolRef[];               // cross-file, non-definition, non-import, kind != field/module/other
  implementations: Map<string, string[]>;
  barrels: BarrelExport[];
  gaps: string[];
}
export function buildReferenceIndex(docs: IndexedDocument[], readSource: (f: string) => string | undefined, gaps: string[]): ReferenceIndex;
export function symbolName(symbol: string): string; // descriptor after the file part, normalized
export function symbolKind(symbol: string): SymbolKind;
```
- `GraphProvider.getReferenceIndex?(): Promise<ReferenceIndex>`; `ScipGraphProvider.getReferenceIndex()` builds it from the cached graph (`BuiltGraph.documents`, `BuiltGraph.jobs`).
- `symbolName`: text after the first `` `…`/ `` file segment; strip `(…).` method suffix and trailing `.`/`#`; `` src/`a.ts`/Registry#getAgent(). `` → `Registry#getAgent`; `` `pkg.mod`/Cls#run(). `` → `Cls#run`.
- `symbolKind`: ends `/` module; ends `#` type; ends `).` → method when the name contains `#`, else function; ends `.` → field when the name contains `#`, else value; anything else (parameters, type parameters, `local`) other.
- `caller`: `symbolName` of the innermost definition occurrence with an `enclosingRange` containing the line, else `(module)`.
- `typeOnly`: true for a `type` kind reference unless the source shows a construction: the character after the range is `(` or the text before the range ends with `new `.
- `gaps`: provider warnings plus one line per `java`/`cs` job: `` `${language} root '${root || "."}' is not yet mapped; its code is missing from the component map` ``.
- `barrels`: documents named `index.{ts,tsx,js,mjs}` or `__init__.py`; non-definition occurrences whose definition is in another file, grouped by defining file.

- [ ] **Step 1: Failing unit tests** in `references.test.ts` over synthetic documents: `symbolName`/`symbolKind` table test (TS function, method, value, field, type, module, parameter; Python method); `excludes field accesses and same-file references`; `marks a class reference followed by ( as a value reference`; `marks new Foo as a value reference`; `marks a bare type annotation as typeOnly`; `attributes the innermost enclosing definition as caller and (module) at top level`; `skips test files and Java documents`; `groups barrel re-exports by defining file`; `carries gaps`.
- [ ] **Step 2: Real-indexer test** `references-scip.test.ts`: temp git repo with `src/store/index.ts` (barrel), `src/store/jobs.ts` (`export function getJob`), `src/api/handler.ts` (`import * as store from "../store/index.js"; export function handle() { return store.getJob(1); }`) and a `tsconfig.json`; `new ScipGraphProvider({ repoRoot }).getReferenceIndex()` contains a non-typeOnly reference from `src/api/handler.ts` to the `getJob` symbol in `src/store/jobs.ts` with caller `handle`. Follow the setup in `packages/server/test/e2e.test.ts`.
- [ ] **Step 3: Run** both → FAIL.
- [ ] **Step 4: Implement** `references.ts`, `BuiltGraph.documents` and `BuiltGraph.jobs`, `getReferenceIndex()`.
- [ ] **Step 5: Run** `pnpm exec vitest run packages/server/test` → PASS; `pnpm typecheck`.
- [ ] **Step 6: Commit** `feat(map): reference index from the SCIP provider`.

### Task 3: Map model parsing and structural validation

**Files:**
- Create: `packages/server/src/map/types.ts`, `packages/server/src/map/model.ts`
- Test: `packages/server/test/map-model.test.ts`

**Interfaces:**
```ts
export interface MapComponent { id: string; name: string; parent: string | null; meaning: string; paths: string[]; external: boolean; utility: boolean }
export interface MapInterface { id: string; name: string; provider: string; requirers: string[]; meaning: string; bind: string[]; kind?: string; evidence: string[] }
export interface UndeclaredUse { interface: string; requirer: string; reason: string }
export interface MapModel { title: string; components: MapComponent[]; interfaces: MapInterface[]; undeclared: UndeclaredUse[] }
export type CheckRule = "model" | "coverage" | "binding" | "requirer" | "undeclared" | "evidence" | "utility";
export interface CheckIssue { rule: CheckRule; message: string; where?: string[] }
export function parseMapModel(json: unknown): { model: MapModel; issues: CheckIssue[] };
```
An interface is cross-process when `kind` is set. Defaults: `paths: []`, `external/utility: false`, `requirers/bind/evidence/undeclared: []`.

Structural issues (rule `model`), each one message naming the ids involved: zod shape errors (then return an empty model); duplicate component or interface ids; invalid or reserved id; unknown parent; parent cycle; no root component; external with paths, children, or utility; non-external without paths; utility with children; utility as provider or requirer; unknown provider/requirer; requirer equal to provider; requirer not a sibling of the provider; in-process interface without `bind` or with `evidence`; cross-process interface with `bind`; in-process interface provided by an external; undeclared entry with unknown interface, unknown requirer or empty reason.

- [ ] **Step 1: Failing tests**: `parses the spec example`, one test per issue above (assert `issues[*].message` contains the ids), `applies defaults`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(map): component model schema and structural validation`.

### Task 4: Resolution and fidelity check

**Files:**
- Create: `packages/server/src/map/ownership.ts`, `packages/server/src/map/bindings.ts`, `packages/server/src/map/resolve.ts`, `packages/server/src/map/check.ts`
- Modify: `packages/server/src/map/types.ts`
- Test: `packages/server/test/map-check.test.ts` (fixture `ReferenceIndex` built in the test from a small table of defs/refs), `packages/server/test/map-ownership.test.ts`

**Interfaces:**
```ts
// ownership.ts
export class ComponentTree { constructor(components: MapComponent[]); get(id): MapComponent | undefined; parentOf(id): string | null;
  childrenOf(id: string | null): MapComponent[]; ancestors(id): string[] /* self first */; within(id, root): boolean;
  childToward(ancestor: string | null, id: string): string | undefined; ownerOf(file: string): string | undefined }
// ownerOf: deepest component (tree depth) with a matching path; ties go to the longest pattern.
// Pattern: "" matches all; trailing "/" is a prefix; glob chars (*?[) use matchGlob from globs.ts; otherwise exact file or directory prefix.

// types.ts additions
export interface Binding { symbol: string; name: string; file: string; line: number; component: string }
export interface CallSite { file: string; line: number; caller: string; symbol: string; component: string; requirer: string; undeclared: boolean }
export interface Delegation { interface: string; side: "provided" | "required"; outer: string; inner: string }
export interface ResolvedInterface extends MapInterface { bindings: Binding[]; sites: CallSite[]; evidenceFiles: { file: string; component: string }[]; reasons: { requirer: string; reason: string }[] }
export interface ResolvedComponent extends MapComponent { fileCount: number }
export interface CheckReport { ok: boolean; coverage: { references: number; covered: number; undeclared: number }; issues: CheckIssue[];
  unclaimedFiles: { component: string | null; files: string[] }[]; unattributedReferences: number;
  utilities: { id: string; references: number }[]; typeDependencies: { from: string; to: string; count: number; symbols: string[] }[]; gaps: string[] }
export interface ResolvedMap { title: string; components: ResolvedComponent[]; interfaces: ResolvedInterface[]; delegations: Delegation[]; report: CheckReport }

// bindings.ts
export function resolveBindings(model: MapModel, tree: ComponentTree, index: ReferenceIndex): { bindings: Map<string, Binding[]>; issues: CheckIssue[] }
// check.ts
export function checkMap(json: unknown, index: ReferenceIndex, fileExists: (file: string) => boolean): { model: MapModel; map: ResolvedMap }
```

Rules (from the spec, with these decisions):
- Bind entry forms: `name`, `Type#member`, `Type#*` (the type and all `Type#…` members), `path/file.ts:name` (restrict to that file). Candidates are definitions of kind function/method/value/type in files owned by the provider subtree. No match → `binding` "unbound"; one name matching symbols in more than one file → `binding` "ambiguous" listing the files and the qualified form; a symbol bound by two interfaces of the same provider → `binding` "bound twice".
- For each non-typeOnly reference: `A = ownerOf(ref.file)`, `B = ownerOf(def.file)`; skip when either is missing or `A === B`. `B` utility → exempt, counted on that utility. `A` utility → `utility` issue. `L` = lowest common ancestor; `a = childToward(L, A)`, `b = childToward(L, B)`; either missing → `unattributedReferences++`. Otherwise counted in `coverage.references`; an interface provided by `b` binding the symbol makes a call site with `requirer = a`, `undeclared = !requirers.includes(a)`; no interface → `coverage` issue grouped by `b` + symbol name with up to 5 `where` samples `file:line (caller)` and the count.
- Undeclared site without a matching undeclared entry → `undeclared` issue; undeclared entry with no undeclared sites → `undeclared` issue "stale".
- Declared requirer of an in-process interface with zero sites → `requirer` issue.
- Cross-process: empty evidence → `evidence` issue; a file that does not exist (`fileExists`) or whose owner is not within the provider or a requirer subtree → `evidence` issue.
- Type-only references between `a` and `b` (neither utility) aggregate into `typeDependencies` (up to 8 symbol names).
- Unclaimed: indexed files with no owner (`component: null`) or whose owner has non-external children.
- Delegation: for each binding and provider-side evidence file, every (parent, child) step from its component up to the provider; for each site and requirer-side evidence file, every step from its component up to the requirer. Deduplicated.
- `report.ok` = no issues. `coverage.covered` = call sites counted; `coverage.undeclared` = undeclared sites.

- [ ] **Step 1: Failing tests** in `map-ownership.test.ts` (deepest wins, longest pattern tie-break, glob, exact file, `""`, `childToward`, cycle-free ancestors) and `map-check.test.ts`, one per rule plus: `covers a reference through a facade`, `derives provided and required delegation across two levels`, `exempts references into a utility`, `reports a utility calling a visible component`, `counts a reference from an unclaimed parent file as unattributed`, `reports type-only dependencies separately`, `returns ok for a clean model`, `reports model issues without resolving`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, coverage of the new files ≥ 95%/90% (`pnpm exec vitest run --coverage packages/server/test/map-*.test.ts` and inspect).
- [ ] **Step 5: Commit** `feat(map): resolve bindings and call sites and check fidelity`.

### Task 5: Evidence for the LLM

**Files:**
- Create: `packages/server/src/map/signals.ts`, `packages/server/src/map/evidence.ts`
- Test: `packages/server/test/map-evidence.test.ts`, `packages/server/test/map-signals.test.ts`

**Interfaces:**
```ts
export interface EvidenceOptions { within?: string; full: boolean }
export interface MapEvidence {
  scope: string; full: boolean;
  tree: { path: string; files: number }[];
  roots: { language: string; root: string }[];
  manifest?: { id: string; paths: string[]; description?: string }[];
  candidates: { id: string; files: number }[];
  matrix: { from: string; to: string; references: number }[];
  surfaces: { candidate: string; symbols: number; groups: { usedBy: string[]; symbols: string[] }[] }[];
  signals: { implementations: { type: string; file: string; implementations: string[] }[]; barrels: BarrelExport[];
    headers: { file: string; comment: string }[]; entryPoints: { file: string; reason: string }[]; registrations: { file: string; line: number; text: string }[] };
  gaps: string[];
}
export function buildEvidence(index: ReferenceIndex, ctx: { readSource: (f: string) => string | undefined; roots: { language: string; root: string }[]; manifest?: ComponentMap }, opts: EvidenceOptions): MapEvidence
export function headerComment(source: string, file: string): string | undefined
export function registrations(source: string, file: string): { line: number; text: string }[]
export function entryPointReason(source: string, file: string): string | undefined
```
- Scope: `within` without trailing `/`, or the deepest directory containing every indexed file. Candidates: each subdirectory of the scope as `dir/` and each file directly in it. References from outside the scope count under the consumer `(outside)`.
- `tree`: directories under the scope with file counts, depth 2 below the scope in brief mode, unlimited in full.
- Surfaces: per candidate, symbols referenced from other candidates or outside, grouped by the sorted set of consumers; symbols printed `name (file:line)`. Brief: at most 12 symbols per group (with `+N more`), headers truncated to 160 characters, at most 40 registrations. Full: no caps.
- Header comment: leading `//` or `#` line block, `/* … */` block or Python module docstring, after a shebang and blank lines.
- Registrations: TS `/\b\w+\.(get|post|put|patch|delete|all|route)\(\s*["'`]/`, `/\.(tool|registerTool|addTool|registerPrompt|registerResource)\(\s*["'`]/`; Python decorators `/^\s*@[\w.]+\.(get|post|put|patch|delete|route|websocket|tool)\(/` and `add_url_rule(`/`add_api_route(`.
- Entry points: `if __name__ == "__main__"`, `__main__.py`, a file listed as `bin` or `main` in a root `package.json`.

- [ ] **Step 1: Failing tests** for each helper and for `buildEvidence` on a fixture index: candidates under `src`, matrix counts, consumer-signature grouping, `(outside)` with `within`, brief caps versus full, gaps carried.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(map): evidence for component inference`.

### Task 6: Persistence and hub routes

**Files:**
- Modify: `packages/server/src/db/schema.ts` (v11), `packages/server/src/app.ts`
- Create: `packages/server/src/repo/maps.ts`, `packages/server/src/routes/map.ts`
- Test: `packages/server/test/map-routes.test.ts`; update `packages/server/test/schema.test.ts` expectations for version 11

**Interfaces:**
- v11: `CREATE TABLE component_maps (session_id TEXT PRIMARY KEY REFERENCES review_sessions(id) ON DELETE CASCADE, model TEXT NOT NULL, resolved TEXT NOT NULL, head_sha TEXT NOT NULL, repo_fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL);`
- `saveMap(db, sessionId, { model, map, headSha, repoFingerprint }): void` (replace in one statement), `getMap(db, sessionId): StoredMap | undefined` with `StoredMap = { model: MapModel; map: ResolvedMap; headSha: string; repoFingerprint: string; createdAt: number }`.
- Routes (mounted at `/api/sessions`):
  - `GET /:id/map/evidence?within=<path>&full=1` → `MapEvidence`.
  - `POST /:id/map/check` body = model JSON → `{ report: CheckReport }` (200 even when not ok).
  - `PUT /:id/map` body = model JSON → 200 `{ report }` when stored; 422 `{ error: "the map fails the fidelity check", report }` otherwise.
  - `GET /:id/map` → `{ model, map, headSha, createdAt, stale?, staleReason? }` (stale computed as in `GET /:id`); 404 `{ error: "no component map for this session" }`.
  - All: 404 unknown session; 400 `{ error: "component maps need the scip graph provider (current: <name>)", phase: "map" }` when `getReferenceIndex` is absent; `IndexError` → 400 with its phase.
- Extract the stale computation in `routes/sessions.ts` into `sessionStaleness(root, headSha, fingerprint)` in a shared module (`packages/server/src/staleness.ts`) and use it from both routes.

- [ ] **Step 1: Failing tests** with a stub provider extended by a fake `getReferenceIndex` (fixture index from Task 4) and a fixture git repo as in `routes.test.ts`: evidence 200; check returns issues; submit 422 on failing model and nothing stored; submit 200 then GET returns the map; resubmit replaces; unknown session 404; provider without index 400; deleting the session removes the map.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** all server tests → PASS.
- [ ] **Step 5: Commit** `feat(map): store and serve component maps`.

### Task 7: `srev map` commands

**Files:**
- Create: `packages/skill/src/map.ts`
- Modify: `packages/skill/src/cli.ts`
- Test: `packages/skill/test/map.test.ts` (fetch mocked as in `api.test.ts`), extend `packages/skill/test/cli.test.ts`

**Interfaces:**
- `getMapEvidence(base, sessionId, opts: { within?: string; full?: boolean })`, `checkMap(base, sessionId, model: unknown)`, `submitMap(base, sessionId, model: unknown)` (returns the 422 body instead of throwing), `getMap(base, sessionId)`, `mapUrl(base, sessionId, level?) = \`${base}/?session=${id}&view=map${level ? \`&level=${level}\` : ""}\``, `prettyReport(report): string`, `prettyEvidence(evidence): string`.
- CLI: `srev map evidence --session <id> [--within <path>] [--full]`, `srev map check --session <id> --model <file>`, `srev map submit --session <id> --model <file> [--open]` (prints `{ ok, url, report }`), `srev map get --session <id>` (prints `{ model, url, stale, report }`). `check` and a refused `submit` set `process.exitCode = 1`. Add usage lines.

- [ ] **Step 1: Failing tests**: client URLs and bodies; `submitMap` returns the report on 422; `prettyReport` lists issues by rule and the coverage line; CLI parses `map check` and errors without `--model`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm exec vitest run packages/skill` → PASS.
- [ ] **Step 5: Commit** `feat(map): srev map commands`.

### Task 8: Web level construction and layout

**Files:**
- Modify: `packages/web/package.json` (add `elkjs` `0.9.3` exact)
- Create: `packages/web/src/map/types.ts` (DTO mirror of `ResolvedMap`), `packages/web/src/map/levels.ts`, `packages/web/src/map/measure.ts`, `packages/web/src/map/layout.ts`, `packages/web/public/THIRD-PARTY-NOTICES.txt`
- Test: `packages/web/test/map-levels.test.ts`, `packages/web/test/map-layout.test.ts`

**Interfaces:**
```ts
export interface LevelPort { id: string; node: string; iface: string; role: "provide" | "require"; boundary: boolean }
export interface LevelEdge { id: string; from: string; to: string; iface: string; kind: "assembly" | "delegate" | "undeclared"; inside: boolean }
export interface Level { id: string | null; children: string[]; neighbors: string[]; ports: Map<string, LevelPort>; portsOf: Map<string, string[]>; edges: Map<string, LevelEdge> }
export function buildLevel(map: ResolvedMap, level: string | null): Level;   // port of the spike's buildView using map.delegations
export function defaultLevel(map: ResolvedMap): string | null;               // the only non-external top component when it has visible parts, else null
export function visibleChildren(map: ResolvedMap, id: string | null): ResolvedComponent[];
export function undeclaredFindings(map: ResolvedMap): { iface: ResolvedInterface; requirer: string; sites: CallSite[] }[];
export function measureText(text: string, font: string): number;            // canvas when available, else 0.6 × size × length
export function elkGraph(map: ResolvedMap, level: Level, order: Map<string, number> | null, measure = measureText): ElkNode;
export async function layoutLevel(map: ResolvedMap, level: Level, elk: ELKLike): Promise<ElkNode>;  // two passes
```
Layout options and leaf geometry are the spike's (`PORT_TOP = 50`, `PORT_PITCH = 22`, WEST ports at `x = -16`, EAST at `x = width`, first pass `FIXED_SIDE`, second `FIXED_POS`; layered, RIGHT, `INCLUDE_CHILDREN`, ORTHOGONAL, network simplex, the spike's spacings). Requirers of an interface are its declared requirers plus requirers seen only on undeclared sites (marked undeclared). Cross-process interfaces connect like in-process ones; their edges get `kind` from declaration and the interface's `kind` field marks the style in the renderer.

- [ ] **Step 1: Failing tests**: `buildLevel` at the system level (externals and the root component; cross-process connector), inside a component (boundary ports, neighbours, delegation edges inside, undeclared edge), two levels deep, utility hidden; `defaultLevel`; `elkGraph` puts inner edges in the frame and ports in the given order; `layoutLevel` with the real `elkjs/lib/elk.bundled.js` returns positioned children and edge sections.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; write the notice file (elkjs 0.9.3, EPL-2.0 text reference and `https://github.com/kieler/elkjs`).
- [ ] **Step 4: Run** `pnpm exec vitest run packages/web/test/map-*.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(web): component map levels and layout`.

### Task 9: Web map page

**Files:**
- Create: `packages/web/src/map/MapPage.tsx`, `packages/web/src/map/MapDiagram.tsx`, `packages/web/src/map/MapPanel.tsx`, `packages/web/src/map/usePanZoom.ts`
- Modify: `packages/web/src/App.tsx`, `packages/web/src/api/client.ts` (`getMap`), `packages/web/src/api/hooks.ts` (`useMap`), `packages/web/src/navigation.ts` (`mapUrl(sessionId, level?)`), `packages/web/src/styles.css` (`.cmap` block)
- Test: `packages/web/test/MapPage.test.tsx`

Behaviour (spec "Web view"): `/?session=<id>&view=map[&level=<id|system>]` renders `MapPage`. Toolbar: title, breadcrumb (System › … › current), "inferred draft" tag, stale warning, Fit/−/+. Canvas: React-rendered SVG from the layout (frame, leaf boxes with UML glyph and "N parts · open", lollipop/socket ports with labels, edges with hit paths, dashed delegation, dashed red undeclared, cross-process edges dotted with the kind in the tooltip), legend. Double-click or the panel's Open button navigates (pushState, `level` param); breadcrumb too; popstate re-renders. Selection highlights and dims. Detail panel per spec (level: meaning, coverage, undeclared uses, utilities, unclaimed files count, gaps; component: files (paths), provides, requires, type-only dependencies; interface: meaning, kind, provider → requirers, bound functions or evidence files, call sites grouped by requirer). Wheel zoom, drag pan, initial `fit(readable)`. The status bar gets a "map" link when `useMap` succeeds. Palette: the artifact tokens under `.cmap`, dark by default, light under `@media (prefers-color-scheme: light)`; app fonts.

- [ ] **Step 1: Failing tests** (fetch mocked, real elk): renders the default level's frame title and parts; clicking an interface port shows its call sites; Open navigates to the child level and updates `level` in the URL; breadcrumb returns; undeclared finding listed; 404 shows "No component map for this session" with the skill prompt; stale chip.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm exec vitest run packages/web` and `pnpm --filter @srev/web build` → PASS.
- [ ] **Step 5: Commit** `feat(web): component map page`.

### Task 10: Skill, plugin build and docs

**Files:**
- Create: `packages/skill/component-map.md`, `docs/component-map.md`
- Modify: `scripts/build-plugin.mjs` (generate `skills/<name>/SKILL.md` for each of `structured-review` and `component-map` in both packages), `AGENTS.md` (map commands, docs link), `README.md` (short section), `docs/harness.md` (runtime dependency: elkjs 0.9.3, EPL-2.0, bundled into the web UI with its notice)
- Regenerate: `plugin/`, `plugins/structured-review/`

Skill content: when to use (an overview of an unfamiliar codebase or subsystem); steps from the spec Pipeline 1–5 with exact `srev map` commands; modelling rules (components from candidates and explicit signals, interfaces from consumer-signature groups named as responsibilities, at most about 15 visible parts per level so nest further, utilities only for configuration/helpers/shared types and only as leaves, cross-process interfaces need `kind` and evidence files, never declare a requirer without call sites, keep undeclared uses only with a reason quoted from the code, use `file.ts:name` for ambiguous binds, `--within` per level for large repositories); check loop until `ok`; relay gaps and unclaimed files to the user; corrections loop via `srev map get`; the model format with the spec example.

- [ ] **Step 1:** Write the skill and docs. Update `build-plugin.mjs`; run `pnpm build && pnpm build:plugin`; confirm both packages contain `skills/component-map/SKILL.md` with the plugin invocation.
- [ ] **Step 2:** Run `pnpm verify`; fix every failure without relaxing gates.
- [ ] **Step 3: Commit** `feat(map): component-map skill, docs and plugin bundles`.

### Task 11: Validation

Not committed: models and outputs for private codebases stay in `~/Projects/pareto/component-map-spike/validation/`.

- [ ] **Step 1: Spike service.** Hub on the private service (`srev serve --repo <path> --port 3470`), session `--base empty`, evidence, translate the spike model to the model format, `srev map check` until ok, compare: the three undeclared writes appear, all other cross-component references covered, the spike's 26 interfaces resolve. View the page in Chrome and compare with the artifact.
- [ ] **Step 2: Fresh inference twice.** Two subagents each follow the generated `component-map` skill on the same commit from scratch; compare components and interface splits; write down the differences.
- [ ] **Step 3: Second TypeScript codebase** with fewer facades and **one Python codebase** of comparable size: run the skill once each; record failures of the rules or the page.
- [ ] **Step 4:** Fix defects found (each with a test), rerun `pnpm verify`, rebuild plugins, commit.
