# Component map

The component map describes a codebase's structure as a nested UML component
diagram. Components provide interfaces (lollipops) and require them (sockets);
each component can be opened to show its parts and which part handles each
outer interface (delegation). Interfaces are named responsibilities bound to
the functions that implement them, and every connector is backed by call sites.

The map is built per session by the `component-map` skill. An LLM writes the
model from index evidence; the hub checks it against the code's references and
stores it only when it matches. The hub never calls a model.

## Using it

Ask your agent, for example: "Use component-map to map this codebase and open
the map." The skill runs:

```bash
srev serve
srev session create --branch HEAD --base empty
srev map evidence --session <id> [--within <path>] [--full]
srev map check --session <id> --model model.json
srev map submit --session <id> --model model.json --open
```

To correct the map, tell the agent what is wrong. It reads the stored model
(`srev map get --session <id>`), revises it, checks it and resubmits; a
resubmission replaces the session's map.

The page is at `/?session=<id>&view=map`, with `&level=<component>` for one
level (`level=system` for the level above the top components). The review's
status bar links to it once a map exists.

## The model

```json
{
  "title": "Job orchestrator",
  "components": [
    { "id": "orchestrator", "name": "Job orchestrator", "parent": null, "paths": [""], "meaning": "Runs scheduled jobs" },
    { "id": "feeds", "name": "Feed service", "parent": null, "external": true, "meaning": "Publishes new items" },
    { "id": "store", "name": "Persistence", "parent": "orchestrator", "paths": ["src/store/"], "meaning": "Facade over repositories" },
    { "id": "infra", "name": "Infrastructure", "parent": "orchestrator", "paths": ["src/lib/"], "utility": true, "meaning": "Helpers" }
  ],
  "interfaces": [
    { "id": "read-models", "name": "Read models", "provider": "store", "requirers": ["api"],
      "meaning": "Paged and point reads", "bind": ["getJob", "JobRepository#find", "src/store/page.ts:listPage"] },
    { "id": "feed-hook", "name": "Feed notification", "provider": "orchestrator", "requirers": ["feeds"],
      "kind": "webhook", "meaning": "POST /hooks/feed", "evidence": ["src/api/hooks.ts"] }
  ],
  "undeclared": [{ "interface": "job-state", "requirer": "api", "reason": "the core owns all state transitions" }]
}
```

- **Components** form a tree. `paths` are repository-relative prefixes ending
  in `/`, files, or globs; `""` claims everything. A file belongs to the
  deepest component whose paths match it; at equal depth the longer pattern
  wins. External systems have no paths. Ids use lowercase letters, digits, `.`,
  `_` and `-`; `system` is reserved.
- **Utility components** hold configuration, helpers and shared types. They are
  leaves, provide no interfaces and may not call visible components. References
  into a utility from its siblings and their parts are exempt from coverage and
  hidden from diagrams; the page lists how many each one hides. A reference
  from further out crosses the utility's parent and needs an interface of that
  parent.
- **In-process interfaces** bind provider symbols: `name`, `Type#member`,
  `Type#*` (the type and all its members) or `path/file.ts:name`. Requirers are
  siblings of the provider.
- **Cross-process interfaces** set `kind` (`http`, `mcp`, `webhook`, `queue`,
  `database` or any other word) and cite `evidence` files inside the components
  they connect.
- **Undeclared uses** keep a requirer that uses an interface off its declared
  requirers, with a reason. They are drawn in red.

## The check

A reference is a use of a function, method or value defined in another file,
or a use of a class as a value (construction, a call, static access,
`instanceof`, passing it as an argument). Type annotations, generic arguments
and member accesses on data (object fields, literal properties) are type-only;
type-only dependencies between components are reported separately. Import
statements and `export … from` re-exports are not references. For each reference the hub finds the level where it crosses
between two sibling components.

The hub stores a map only when the check finds no issue:

| Rule | Issue |
|---|---|
| model | The model's structure: unknown ids, parent cycles, requirers that are not siblings, the utility and external rules |
| coverage | A reference between sibling components that no interface of the provider binds |
| binding | A bind entry that matches nothing or several files, or a symbol bound by two interfaces of one provider |
| requirer | A declared requirer of an in-process interface with no call sites |
| undeclared | A requirer using an interface without being declared or listed as undeclared with a reason, or an undeclared entry with no such use |
| evidence | A cross-process interface without evidence files, or with files that do not exist or lie outside the components it connects |
| utility | A utility calling a visible component |

The report also lists, without blocking: unclaimed files (files under the
mapped directories that no component claims, or that fall through to a
component with parts), references starting in them, hidden utility references,
type-only dependencies, and index gaps.

Delegation is derived: when a component provides an interface, the parts whose
files hold its bindings (or its provider-side evidence) receive it; when a
component requires one, the parts holding the call sites (or requirer-side
evidence) receive the socket.

## Languages and limits

TypeScript/JavaScript and Python are mapped. Java and C# roots appear as index
gaps marked "not yet mapped". Failed indexer roots, skipped toolchains and
tracked source files that no indexed project includes (a script outside every
`tsconfig.json`) are gaps too; the page shows every gap.

References come from SCIP indexes and are static: dynamic dispatch, dependency
injection and string-keyed registries can hide calls. Cross-process interfaces
come from reading code and are not traced.

The map is stored per session. When the working tree changes, the page marks
it stale; recreate the session and the map for the current code.

## Third-party software

The page lays out diagrams with [elkjs](https://github.com/kieler/elkjs) 0.9.3,
licensed under the Eclipse Public License 2.0. The web build ships its notice
in `THIRD-PARTY-NOTICES.txt`.
