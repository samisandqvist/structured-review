---
name: component-map
description: Map a codebase's structure as a nested UML component diagram. Infers components and the interfaces they provide and require from index references, checks that every cross-component call is covered, and opens an interactive map with drill-down. Use when someone wants the structural overview of an unfamiliar codebase or subsystem.
---

# Component map

## What this skill does

It builds a component map: a UML-style component diagram where components
provide interfaces (lollipops) and require them (sockets), and each component
can be opened to show its parts and which part handles each outer interface.
You write the model; the hub checks it against the code's references and
refuses it until it matches how the code actually calls itself.

1. Ensure the hub runs and a session exists (`srev serve`, `srev session create`)
2. List what the system does, from its design and docs, before reading code
3. Read the evidence (`srev map evidence`) and assign the code to those responsibilities
4. Write the model and check it until it passes (`srev map check`)
5. Review the model's abstraction level, then store it and give the user the link (`srev map submit`)
6. Revise it when the user says something is wrong (`srev map get`, check, submit)

The map has to be true and it has to be logical. True: it matches how the code
calls itself, so never weaken the model to make the check pass. Logical: each
component is something the system does and each interface is the information
or responsibility that crosses a boundary. The check proves the first; the
second is your job, and a map that only mirrors directories, layers and
transports fails it even when the check passes.

## The srev CLI

Resolve the installed skill's directory from the path of this SKILL.md.
The launcher is at `../../scripts/srev.mjs` relative to that directory.
Use its absolute path for every `srev` command, keeping the working directory
in the repository being reviewed. For example, replace the path below with
the resolved launcher path:

```bash
node "/absolute/installed/plugin/scripts/srev.mjs" <command>
```

The launcher checks indexers on first use, even if no startup hook ran.
It sets SREV_DATA_DIR and SREV_INDEXER_HOME using the host's plugin data directory
when available; otherwise it uses `~/.local/share/structured-review`
(or XDG_DATA_HOME). An explicit SREV_DATA_DIR overrides that choice. State stays
outside the reviewed repo and the installed plugin. Requires Node >= 22.13
and npm. Relay installation errors; the same command can be retried.
Every command prints JSON on stdout; add `--pretty` for human-readable output.
Never touch the SQLite file or hand-roll `curl` — the CLI is the stable surface.

```bash
srev serve [--repo <path>] [--port N]
srev session create --branch HEAD --base empty      # whole-repository session for a map
srev map evidence --session <id> [--within <path>] [--full]
srev map check --session <id> --model <file.json>   # exit code 1 until the model passes
srev map submit --session <id> --model <file.json> [--open]
srev map get --session <id>                         # stored model, URL, staleness, report
```

## Steps

1. `srev serve`, then reuse the user's review session if they have one, or
   create one with `srev session create --branch HEAD --base empty`. Relay
   `indexWarnings`. TypeScript/JavaScript and Python are mapped; Java and C#
   roots appear in the report as gaps "not yet mapped". Tell the user about
   every gap.
2. **Responsibilities first.** Before you read the evidence, write down the
   five to nine top-level things the system does, each as a short phrase with
   a verb ("runs remits on a schedule", "decides who may use which agent").
   Take them from the design when the repository has one: OpenSpec specs and
   change designs (`openspec/specs/`, `openspec/changes/*/design.md`),
   architecture documents, ADRs, the component manifest. Otherwise take them
   from the README, the docs, entry points and the descriptions of the tools
   and routes the system offers. Then make the design decisions in
   [Logical structure](#logical-structure) for that list. This list is the
   draft of the top level; the code decides where its edges fall.
3. `srev map evidence --session <id> --pretty` for orientation, then the JSON
   form for detail. It holds:
   - `candidates`: the scope's direct subdirectories and files with file counts;
   - `matrix`: call/value references between candidates;
   - `surfaces`: per candidate, the symbols other candidates use, grouped by
     the set of users (`usedBy`). Each group is a strong interface candidate;
   - `signals`: implementations of interfaces and abstract types, barrel
     modules with their export groups, module header comments, entry points,
     and route/tool registrations (the cross-process surface);
   - `manifest`: the repository's own `.review-components.json`, when present;
   - `gaps`: index gaps.
   `(outside)` stands for files outside the scope (with `--within`, the rest of
   the repository). The brief form caps symbol lists (`+N more`); run `--full`
   before writing bind entries so you see every symbol a surface needs.
   Assign the candidates to your responsibilities. Directories are evidence
   for the assignment: one directory can serve several responsibilities, and
   one responsibility can span directories (list files or globs in `paths`).
   When code fits no responsibility, the list is missing one or the code is
   support (a utility or tooling); decide which. When a responsibility has no
   code, tell the user.
   For a large codebase, model the top level first, then run
   `--within <dir>` for each component you nest, and repeat step 2 for its
   parts, so each level stays readable.
4. Write the model file (format below) and run `srev map check`. Read every
   issue and fix the model, then check again, until it prints
   `fidelity check: passed`.
5. Review the model against [Reviewing the abstraction](#reviewing-the-abstraction)
   and fix what fails, checking again after each change. Then
   `srev map submit --session <id> --model <file>`; give the user the printed
   `url` (or pass `--open`). Summarize: the top-level parts, the design
   decisions you made (where state lives, what you merged), where the code
   departs from the repository's design, the undeclared uses you kept and
   why, hidden utilities, unclaimed files and gaps.
6. Corrections: when the user says a concept is wrong ("these two are one
   thing", "the API should not write state"), run `srev map get`, edit the
   model, check and resubmit. A resubmission replaces the session's map.

## Mapping a review

In a review session (a session with a base commit), the map describes the
code before the change, and the hub marks the change on top of it. Evidence
and the check run on the base (the evidence says `base <sha>`); the first call
checks out and indexes the base, which takes about as long as indexing the
working tree. Model the base exactly as you would any codebase: do not add
requirers or interfaces for calls the change introduces.

The base cannot show code the change adds. The evidence lists the directories
of added files under `added by the change`. When one holds a new part of the
system (a new module, package or service), add a component for it with its
paths, where it belongs in the tree. Its paths match no base file, so the
check accepts it; give it no interfaces and list it as no requirer. The hub
marks it added, and calls into and out of it show as new surfaces and new
dependencies. Files added inside an existing component need nothing. When
`srev map submit` lists files as not placed, add components for them and
submit again.

On submit the hub compares the head with the
base and stores the change: changed, added and removed components, new, removed and changed
dependencies, new surfaces (head calls into a symbol no interface binds),
touched contracts and changed files the model cannot place. `srev map submit`
and `srev map get` print it. Give the reviewer the link and point out the new
dependencies and new surfaces; they are the structural questions of the
review. The reviewer can open each changed part on the map and review its
changed items from there.

## Logical structure

A component map is a design view. Build it the way a designer would, from
responsibilities down, and use the code to place and verify them.

- **A component is a responsibility.** Name it for what it does for the
  system or its users ("Remit scheduling", "Directory", "Feed delivery").
  Mechanisms such as an HTTP edge, transport and auth, a rate limiter, a
  persistence layer, a runtime host or a vendor stack are how a responsibility
  is carried out. They belong inside the responsibility they serve, as parts
  of it or as a utility, at a lower level.
- **An interface is the information or responsibility that crosses the
  boundary**: "Job status", "Delegation grants", "Information feed". The
  transport (REST, MCP, a queue), the URL prefix, the auth guard and the
  caller's role are attributes; record the transport in `kind` and the rest
  in `meaning`. Test each interface name: if the transport changed, or admin
  and user calls moved to one endpoint, would the name change? If yes, it
  names a channel; rename it after what flows through it, and split it when
  several kinds of information flow through the same channel.
- **Decide where state lives.** By default, state belongs to the component
  that owns its rules, even when every component writes to the same database;
  a shared database is a deployment fact. Make data storage its own component
  only when the design says so or when several components read the same data
  and none owns it, and say which case applies in its `meaning`.
- **Components that require each other are one component.** When two
  siblings each use an interface the other provides, merge them at this level
  and show the split one level down, unless the design says they are separate
  and the mutual use is a finding (then keep the wrong direction as an
  undeclared use).
- **About five to nine parts per level.** Fewer suggests the level adds
  nothing; more suggests a missing grouping. Above about 15 visible parts
  (external systems do not count), nest.
- **Recurse.** Open each component and repeat: its responsibilities, its
  state, its interfaces. The lower the level, the closer the parts may come
  to mechanisms; at the leaves, a part may be a single module.

When the repository has a design (OpenSpec, an architecture document, the
manifest), its components and interfaces are the model's, and the code is
mapped onto them. Code that does not fit the design is a finding: report it,
and show it as an undeclared use where it is a call the design does not allow.

## Modelling rules

- **Components** are the responsibilities from step 2, placed on the code
  through the candidates and the explicit signals: a directory, a facade
  module, a set of files with one responsibility. Give each
  an `id` (lowercase, digits, `.`, `_`, `-`; `system` is reserved), a short
  `name` and a one-line `meaning` taken from header comments where possible.
  `paths` are repository-relative prefixes ending in `/`, files, or globs. A
  file belongs to the deepest component whose path matches it; between
  components at the same depth the longer pattern wins, so a single file path
  beats a sibling's directory prefix.
- **One root component** claims the code (`"paths": [""]` for a whole
  repository, or the service directory in a monorepo). External systems
  (other services, people, model providers) are root-level components with
  `"external": true` and no paths.
- **Nest** by grouping siblings into a parent component and giving the
  parent interfaces of its own (see the part counts in
  [Logical structure](#logical-structure)). When you nest a directory that has a barrel or facade
  module (`index.ts`, `__init__.py`), give that module a part of its own or put
  it in a part; otherwise its re-exports show up as unclaimed files and
  unattributed references.
- **Code around the product**: scripts, docs, packaging and setup files can be
  one `tooling` component beside the main one, or stay outside the root's
  paths. Test support that is not named like a test (fixtures, harnesses) is
  mapped like any code; give it its own component so its calls do not blur
  the production parts.
- **Interfaces** are named for the information or responsibility they carry
  ("Job status", "Job requests"). Start from the `usedBy` groups of a surface:
  symbols used by the same set of components usually form one interface; split
  a group when it mixes responsibilities, and merge groups that carry the same
  information to different requirers. An interface has one `provider` and `requirers` that
  are siblings of the provider. `bind` lists provider symbols: `name`,
  `Type#method`, `Type#*` (a type, its constructor and all its members) or
  `path/file.ts:name` when a name exists in several files. A symbol may be
  bound by only one interface of the same provider.
- **Granularity is your job.** The check proves every call is covered; it
  does not stop one broad interface (one `Type#*` with seven requirers) from
  hiding which parts use what. Split reads from writes, and split a group
  whose requirers use different symbols. Splitting is also how a violation
  becomes visible: if the API writes state that only the core should write,
  a separate "state writes" interface lets that use show as undeclared.
- **Bind at every level the call crosses.** A call from one top-level part
  into a nested part must be bound by an interface of the top-level provider;
  the hub derives which inner part handles it (delegation).
- **Never declare a requirer that has no call sites.** The check refuses it.
- **Undeclared uses**: when a part uses an interface it should not (the code's
  own comments or structure say so), keep the requirer off `requirers` and add
  an `undeclared` entry whose `reason` quotes or cites that evidence. These
  are drawn in red and are often the most useful finding on the map. Do not
  use undeclared entries to silence coverage you could model.
- **Utilities** (`"utility": true`) are only for configuration, helpers and
  shared types. A utility is a leaf, provides no interfaces, and may not call
  visible components (a configuration module that validates against other
  components is a visible component). References into a utility from its
  siblings are exempt from coverage and hidden from diagrams; references from
  further out cross its parent and need an interface of that parent. If a
  utility hides a large share of all references, look for responsibilities in
  it that deserve a visible part (a wrapper around a model provider, a client).
- **Cross-process interfaces** (HTTP routes, MCP tools, webhooks, queues,
  databases, clients of other services) set `kind` (free text such as `http`,
  `mcp`, `webhook`, `queue`, `database`) and list `evidence` files. They have
  no `bind`. Use the registrations and client modules from the signals, and
  group the routes by the information they carry: routes that share a prefix
  or a guard but serve different responsibilities are different interfaces,
  and an admin route and a client route over the same data are one.
  External systems are root-level, so connect them to the root component that
  contains your code (provider or requirer), and list as evidence the files
  that serve or call them, wherever they sit inside. The hub delegates the
  connection from the root's boundary down to the parts holding those files,
  so opening the root shows which part talks to Postgres or serves the
  webhook. In a monorepo, other services you do not map are external systems.

## Model format

```json
{
  "title": "Job orchestrator",
  "components": [
    { "id": "orchestrator", "name": "Job orchestrator", "parent": null, "paths": [""],
      "meaning": "Runs jobs for new feed items and reports their results" },
    { "id": "feeds", "name": "Feed service", "parent": null, "external": true,
      "meaning": "Upstream service that publishes new items" },
    { "id": "intake", "name": "Item intake", "parent": "orchestrator",
      "paths": ["src/intake/", "src/api/hooks.ts"],
      "meaning": "Accepts new items from the feed service and requests a job for each" },
    { "id": "jobs", "name": "Job lifecycle", "parent": "orchestrator",
      "paths": ["src/core/", "src/store/jobs.ts"],
      "meaning": "Owns job state and its transitions; keeps that state in its own tables" },
    { "id": "reporting", "name": "Result reporting", "parent": "orchestrator",
      "paths": ["src/api/", "src/store/results.ts"],
      "meaning": "Answers operators' questions about jobs and their results" },
    { "id": "infra", "name": "Infrastructure", "parent": "orchestrator",
      "paths": ["src/lib/", "src/config.ts"], "utility": true,
      "meaning": "Configuration, helpers and shared types" }
  ],
  "interfaces": [
    { "id": "job-requests", "name": "Job requests", "provider": "jobs",
      "requirers": ["intake"], "meaning": "Ask for a job, retry or cancel one",
      "bind": ["requestJob", "retryJob", "cancelJob"] },
    { "id": "job-status", "name": "Job status", "provider": "jobs",
      "requirers": ["reporting"], "meaning": "Paged and point reads of jobs",
      "bind": ["getJob", "listJobsPage"] },
    { "id": "new-items", "name": "New items", "provider": "orchestrator",
      "requirers": ["feeds"], "kind": "webhook",
      "meaning": "The feed service posts each new item to POST /hooks/feed",
      "evidence": ["src/api/hooks.ts"] }
  ],
  "undeclared": [
    { "interface": "job-requests", "requirer": "reporting",
      "reason": "src/core/index.ts says operators only read jobs; the results page cancels jobs directly" }
  ]
}
```

## Reviewing the abstraction

Before you submit, go through every level of the model:

- Read the component names aloud as "the system ...": "the system delivers
  feeds" works; "the system HTTP edge" does not. Rename or regroup the parts
  that fail.
- Look for interface and component names built on transport or technology
  words (API, REST, HTTP, MCP, endpoint, controller, client, server, store,
  database, host). Some are right, such as an external system's own API at
  the root level; most name a channel or a layer.
- Look for an interface whose bindings land in several unrelated parts of its
  provider, and for two interfaces of one provider that carry the same
  information. The first is a channel holding several responsibilities; the
  second is one responsibility split by caller or prefix.
- Look for siblings that require each other, and for a data storage
  component whose existence nobody decided.
- Compare the top level with the responsibility list from step 2. A
  responsibility that disappeared, or a part nobody would list as something
  the system does, needs a reason.

## Reading the check

- `[model]`: structural problems (unknown ids, cycles, a requirer that is not
  a sibling). Fix these first; nothing else is evaluated until they are gone.
- `[coverage]`: a reference between two sibling components that no interface
  binds. Bind the symbol in an interface of that provider (new or existing).
- `[binding]`: a bind entry that matches nothing, matches several files (use
  the `file:name` form) or a symbol bound twice.
- `[requirer]`: a declared requirer with no call sites. Remove it.
- `[undeclared]`: a requirer using an interface without being declared.
  Declare it, or keep it undeclared with a reason. A stale entry must go.
- `[evidence]`: a cross-process interface without evidence files, or with
  files outside the components it connects.
- `[utility]`: a utility calling a visible component. Make it a visible
  component or move the code.

Coverage counts call sites (references), so one undeclared entry can stand
for several undeclared call sites.

Not blocking, but tell the user: `unclaimed files` (files under the mapped
directories that no component claims, or that fall through to a component
that has parts: give them a part), `unattributed references` (calls from
those files), hidden utility references, type-only dependencies, and gaps
(the report says `gaps: none` when there are none). Test files (`*.test.ts`,
`test_*.py` and similar) are never mapped.

Known limit: a call that bypasses a facade (importing `store/artifacts.ts`
directly although the store's header says callers go through its index)
looks like any other use of the store's interface. Mention such bypasses to
the user when you see them; the map cannot show them yet.
