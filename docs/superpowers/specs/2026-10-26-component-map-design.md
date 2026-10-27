# Component map design

Status: implemented on the feature branch and validated on four codebases. Written from a throwaway
spike on a private TypeScript service of 79 source files (a background job
orchestrator with an operator API, a persistence facade and two upstream
services): SCIP evidence extraction, a hand-run LLM inference, a mechanical
check and an interactive renderer. Nothing from the spike was committed. The
spike's scripts, model and rendered page are kept privately with the author;
the rendered page is the visual reference for this design.

## Intent

Most codebases have no up-to-date description of their structure: which parts
exist, what each part offers the others, who depends on what, and which parts
carry the connections to other systems. A newcomer assembles that picture by
reading code. The component map gives them that overview directly, as one
diagram type at every level: a UML-style component diagram where components
provide interfaces (lollipops) and require them (sockets), and where each
component can be opened to show its parts and which part handles each outer
interface (delegation).

Interfaces are conceptual: named units of responsibility such as "Job
lifecycle" or "Read models". Each is bound to the 1..N functions that implement
it, and every connection is backed by the call sites that use it. The diagram
stops above function level; the functions and call sites are one click away in
a detail panel.

The value is fidelity. A diagram that looks plausible but does not match how
the code actually calls itself is worse than no diagram. Every rule below about
evidence and checking exists to protect that.

## Goals

- A reader gets the structural overview of an unfamiliar codebase in minutes.
- Every line on the map is backed by references in the code; every
  cross-component reference in the code appears on the map, either inside an
  interface or as a visible undeclared use.
- Components nest to any depth; each level is a readable diagram.
- The model is inferred by an LLM from index evidence; a human corrects the
  concepts in plain language through Claude Code and the LLM revises the model.

## Non-goals (this phase)

- Integration with the review walk: highlighting the parts a change touches,
  undeclared uses as review findings, replacing the shape-of-the-change list.
  The review skill does not invoke the map.
- Keeping a model in the analysed repository, versioning it, or updating it in
  CI. A map is built from scratch per session.
- Editing the diagram in the UI (moving boxes, renaming, drawing connectors).
  The map is render-only.
- Comment anchors on diagram elements. Corrections go through Claude Code.
- Higher-level grouped interfaces (for example "Account lookup" and
  "Permissions" shown as one interface at the outer level). The spike's granularity is the
  default; grouping is a candidate later addition.
- Runtime traces or message-flow analysis. Cross-process interfaces come from
  code reading and are marked as such.

## Anti-goals

- Edges the code does not support. A connector without call sites behind it is
  a defect, whatever the LLM believed.
- Hidden traffic. A cross-component reference that the model neither covers nor
  marks as undeclared is a defect.
- A map that silently degrades. If the index is incomplete (missing indexer,
  failed root, unsupported provider), the map says so on the page.

## Evidence from the spike

| Question | Result |
|---|---|
| Raw signal | 3,260 cross-file references in 74 documents; after removing type-only references, field accesses and import statements, 342 cross-component call/value references |
| Shared types | One `types.ts` received over 400 references, mostly field accesses; types swamp the behavioural signal unless separated |
| Namespace imports | `import * as store from "./store/index.js"; store.getJob()` is recorded by scip-typescript 0.4 as a `local N` symbol. The store facade's visible surface grew from 9 to 43 symbols once these were resolved through the module's exports; 128 call sites were recovered |
| Re-exports | References through a barrel resolve to the original definition, so bindings land in the defining file |
| Interface splitting | Grouping a component's boundary symbols by the set of components that use them reproduced the natural split of the persistence facade (writes used only by the core, reads used only by the API, a restricted query used only by one tool) with little LLM adjustment |
| Explicit signals | TypeScript interfaces with implementations (a registry with two implementations, a typed client for an upstream service), barrel modules and module header comments named most interfaces |
| Cross-process | An inbound webhook, an outbound client protocol and a third-party HTTP API were visible only through module comments and route registration |
| Coverage | The hand-written model covered 339 of 342 references; the remaining 3 were real: the API layer writing core state directly although the core module's header says it owns all state transitions |
| Layout | elkjs layered layout with hierarchy handling, orthogonal routing and fixed-side ports; a second pass with `FIXED_POS` ports in the first pass's order keeps ports below the title and labels clear |

## Concepts

- **Component.** A named part of the system with a one-line meaning and a set
  of files given as repository-relative path prefixes and globs. Components
  form a tree. A file belongs to the deepest component whose paths match it.
- **External system.** A component with no files: another service, a person
  role, a model provider. Appears only at the level where its interfaces
  connect.
- **Utility component.** A component the model marks as shared infrastructure
  (configuration, helpers, shared types). It is hidden from diagrams; the page
  lists it with the number of references it hides. A utility must be a leaf,
  provides no interfaces, and may not reference visible components: a utility
  that calls back into a visible component fails the check. References from
  visible components into a utility are exempt from coverage.
- **Interface.** A named responsibility with a one-line meaning, one provider
  component and declared requirer components, all siblings of the provider in
  the tree. In-process interfaces are bound to provider symbols.
  Cross-process interfaces carry cited evidence files and a kind (`http`,
  `mcp`, `webhook`, `queue`, `database`, free-form).
- **Binding.** A provider symbol that belongs to an interface, resolved by the
  hub to its file and line.
- **Call site.** A reference from outside the provider to a bound symbol, with
  file, line and enclosing caller. Its requirer is the caller's ancestor that is
  a sibling of the provider.
- **Undeclared use.** A call site whose requirer is not declared on the
  interface. The model may keep it undeclared only with a written reason (for
  example "the core module's header says it owns all state transitions"); it is drawn
  in red.
- **Delegation.** Derived by the hub from bindings and call sites; the model
  does not contain it. When a component provides an
  interface, the parts whose files hold its bindings receive the interface and
  a dashed connector from the component's boundary port. When a component
  requires an interface, the parts whose files hold the call sites receive the
  socket and a dashed connector to the boundary port.

## Fidelity rules

`srev map check` evaluates a model against the session's index and reports:

1. **Coverage.** Every call/value reference between two different visible
   sibling components, at every level, is a call site of some interface. The
   check lists uncovered references grouped by provider symbol.
2. **Unbound declarations.** A binding that matches no symbol in the provider's
   files.
3. **Requirers without evidence.** A declared requirer of an in-process
   interface with no call sites.
4. **Undeclared uses without a reason.**
5. **Cross-process interfaces without evidence files,** or with evidence files
   outside the components they connect.
6. **Unclaimed files.** Indexed source files that belong to no component. The
   repository root component claims everything by default; the check lists
   files that fall through to it at levels where it has parts.
7. **Index gaps.** Indexing warnings and failed roots for the session, carried
   onto the map.

The hub stores a map only when items 1 to 5 are empty. Items 6 and 7 are shown
on the page. Coverage and the gap list are displayed in the default panel.

What counts as a reference: function, method and value references (including
constants). Type-only references and member accesses on data types are excluded
from coverage and from interfaces; the check reports type-only dependencies
between components separately, and the component panel lists them. Import
statements are not references. (Builder's call where the existing decoder's
value/type distinction needs refining.)

## Model format

JSON, written by the LLM, validated by the hub.

```json
{
  "title": "Job orchestrator",
  "components": [
    { "id": "orchestrator", "name": "Job orchestrator", "parent": null, "paths": [""],
      "meaning": "Runs scheduled jobs and records their results" },
    { "id": "feeds", "name": "Feed service", "parent": null, "external": true,
      "meaning": "Upstream service that publishes new items" },
    { "id": "store", "name": "Persistence", "parent": "orchestrator",
      "paths": ["src/store/"], "meaning": "One repository per aggregate behind a facade" },
    { "id": "infra", "name": "Infrastructure", "parent": "orchestrator",
      "paths": ["src/lib/", "src/config.ts", "src/types.ts"], "utility": true,
      "meaning": "Configuration, helpers and shared types" }
  ],
  "interfaces": [
    { "id": "read-models", "name": "Read models", "provider": "store",
      "requirers": ["api", "host", "core"],
      "meaning": "Paged and point reads for operators",
      "bind": ["getJob", "listJobsPage", "JobRepository#find", "ReadModel#*"] },
    { "id": "feed-hook", "name": "Feed notification", "provider": "orchestrator",
      "requirers": ["feeds"], "kind": "webhook",
      "meaning": "The feed service calls POST /hooks/feed when new items arrive",
      "evidence": ["src/api/hooks.ts"] }
  ],
  "undeclared": [
    { "interface": "job-state", "requirer": "api",
      "reason": "The core module's header says it owns all state transitions; the API writes job state directly" }
  ]
}
```

- `bind` entries name symbols in SCIP descriptor form relative to the file
  (`name`, `Type#method`, `Type#*` for all members). The hub resolves them
  within the provider's files; ambiguity is a check error.
- Ids are stable within a session so corrections can refer to them.

## Languages

TypeScript and Python are mapped in this phase. Java and C# roots in a session
appear on the map as index gaps marked "not yet mapped", so their code is never
silently missing. They are a later addition if the map proves useful.

## Pipeline

A new skill, `component-map`, ships in the same plugin as `structured-review`.
The build script currently generates one skill; it must generate both, for
Claude Code and Codex.

1. Ensure a hub and a session. For a whole codebase, a session with
   `--base empty`; for a branch, the user's existing session. Mapping requires
   the SCIP provider; other providers report "not supported".
2. `srev map evidence --session <id>` prints the evidence the LLM reasons from:
   - candidate components: directory tree with file counts, project roots, the
     component manifest when present;
   - reference matrix between candidate components (call/value only);
   - boundary surfaces: per candidate component, the symbols referenced from
     outside it, grouped by the set of components that reference them;
   - explicit signals: interfaces/abstract types with their implementations,
     barrel and facade modules with their export groups, module header
     comments, detected entry points and route/tool registrations.
   It has a brief default and a `--full` mode, like `srev context`, sized for
   an LLM context. Evidence for a sub-tree can be requested with
   `--within <path>` so large codebases are modelled level by level.
3. The LLM writes the model, names concepts from the explicit signals and the
   grouping, and runs `srev map check --session <id> --model <file>` until it
   passes. The skill tells it to resolve failures by changing components,
   bindings or interface splits. Declaring a requirer without call sites is
   forbidden.
4. `srev map submit --session <id> --model <file>` re-runs the check in the
   hub, stores the model with the resolved bindings, call sites and check
   report, and prints the map URL.
5. Corrections: the user tells Claude Code what is wrong. The skill fetches the
   stored model (`srev map get`), revises it, checks and resubmits. A
   resubmission replaces the session's map.

The hub validates, resolves and checks; it never calls a model, consistent with
the architecture's boundary between the agent and the server.

## Index prerequisite: namespace member references

Fix in the shared SCIP decoder: an occurrence with a `local` symbol that
directly follows (same line, separated by `.`) an occurrence of a module symbol
is resolved by name through that module's definitions and re-exports. This
benefits the existing call graph and flows as well and can land on its own
before the map.

## Hub

- Persistence: a session-scoped map record holding the submitted model, the
  resolved data (bindings with file/line, call sites with caller and requirer),
  the check report and the commit and fingerprint it was built from. One map
  per session; resubmission replaces it in a transaction. Stale-session
  detection applies to the map like the rest of the session.
- Routes: submit, get, check (dry run), and a read route serving the resolved
  map to the web UI.
- Size target: resolving and checking a model for a repository of about 100k
  lines completes in seconds once the index is cached.

## Web view

A map page in `packages/web`, reached from the session and printed by
`srev map submit`. It reproduces the spike artifact:

- One level at a time: the opened component as a frame with boundary ports,
  its visible parts inside, and the sibling components it connects to outside
  the frame. The repository root level shows external systems.
- Notation: lollipop on the left for provided, socket on the right for
  required, solid connector for declared use, dashed grey for delegation,
  dashed red for undeclared use, a distinct style for cross-process interfaces.
  The UML component glyph on each box; "N parts · open" on boxes with parts.
- Breadcrumb navigation; double-click or an Open button to go inside; a URL per
  level so a level can be linked.
- Detail panel: for the level, its meaning, coverage, undeclared uses, utility
  components and index gaps; for a component, its files, provided and required
  interfaces and type-only dependencies; for an interface, its meaning,
  provider and requirers, bound functions and call sites grouped by requirer,
  with file:line.
- Selection highlights the interface or component and dims the rest.
- Wheel zoom, drag pan, Fit; the initial zoom keeps text readable and pans
  from the left when the level is wide.
- Layout with elkjs: layered, left to right, hierarchy handling, orthogonal
  routing, two passes (free port order, then fixed port positions in that
  order). Port and title geometry computed by the renderer.
- Light and dark themes through the web app's existing token approach, using
  the artifact's diagram palette (tinted neutrals, a blue selection accent, red
  for undeclared use).
- Levels with more than about 15 visible parts are a modelling problem: the
  skill instructs the LLM to nest further. The renderer still draws them.

## Constraints

- elkjs is EPL-2.0. The project is MIT. Bundling elkjs into the distributed web
  build is permitted; the distribution must carry elkjs's license notice and
  point to its source. The quality harness's dependency table needs an entry.
- Node and SCIP indexers as today; no new runtime services.
- Generated plugin packages are rebuilt with `pnpm build && pnpm build:plugin`.

## Validation

Before the first public version:

1. The spike service: the map reproduces the spike's components, finds the
   three undeclared writes, and covers every other cross-component reference.
   The spike's model and counts serve as the expected result; they are kept
   outside this repository.
2. A second TypeScript codebase with fewer facades.
3. One Python codebase of comparable size.
4. Run the inference twice on the same commit and compare the models. Large
   differences in components or interface splits are reported; they do not
   block release in this phase.

The structured-review harness covers the decoder fix, model validation,
resolution, the check rules and the web view's level construction with unit
and component tests against fixtures.

## Delivery

The namespace-member fix lands on main on its own. The `component-map` skill,
the `srev map` commands, the hub routes and the web view are built on a feature
branch and merged when the validations pass, so releases do not ship a partial
map.

## Later phases

- Grouped interfaces that collapse at outer levels.
- Java and C# mapping.
- Comment anchors on components and interfaces.
- Review integration: changed components and interfaces highlighted on the map,
  undeclared uses introduced by the change reported as findings.
- A model maintained in the analysed repository.

## Left to the builder

- Command and route names beyond those given, table schema, and how resolved
  data is cached.
- Exact evidence formatting and the brief/full size budgets.
- How to detect route and tool registrations per language.
- React component structure, and whether layout runs in a web worker.
- The heuristics that propose candidate components before the LLM decides.
