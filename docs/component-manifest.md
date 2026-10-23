# Component manifest

A repository can describe its components in `.review-components.json` at its
root. Structured Review uses the description to show the shape of a change
before the walk: which components the change touches, which of their contracts
changed, and which consumers of those contracts the change leaves untouched.
The file is optional. Other review tools can read the same file; nothing in it
is specific to Structured Review.

A call graph can't show that a change to one service's HTTP API affects another
service that calls it over the network, or that a migration affects every
service reading the table. The manifest states those relationships so the
reviewer sees them.

## Format

```json
{
  "components": [
    {
      "id": "api",
      "description": "Public HTTP API",
      "paths": ["services/api/**"],
      "criticality": "high",
      "contracts": [
        { "kind": "http", "paths": ["services/api/src/routes/**"] },
        { "kind": "schema", "paths": ["services/api/migrations/**"] }
      ],
      "consumers": ["web", "worker"]
    },
    { "id": "web", "paths": ["apps/web/**"] },
    { "id": "worker", "paths": ["services/worker/**"], "criticality": "low" }
  ]
}
```

| Field         | Required | Meaning                                                                                                              |
| ------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `id`          | yes      | Unique name, shown to the reviewer and used in `consumers`                                                          |
| `description` | no       | One line on what the component is for                                                                               |
| `paths`       | yes      | Globs for the files the component owns                                                                              |
| `criticality` | no       | `high`, `normal` (default) or `low`; orders the components and tells the reviewer where a mistake costs most |
| `contracts`   | no       | What other components rely on: each entry has a free-form `kind` (`http`, `schema`, `events`, `package`) and globs |
| `consumers`   | no       | Ids of components that use this component's contracts                                                               |

Globs use `**`, `*` and `?` over repository-relative paths, the same rules as a
plan's `orphanFiles`; wildcards match dotfiles. Unknown fields are ignored.

## Resolution

- A file belongs to the **first** component, in file order, with a matching
  path glob. List a nested component before the component that contains it.
- A changed file matching one of its component's `contracts` globs marks that
  contract kind as changed.
- When a component has a changed contract, each of its consumers is listed.
  A consumer with no changed file of its own appears under **Outside the
  change**: its code is unchanged, and it may depend on what changed.
- Changed files that no component claims appear under **Not in any
  component**.

## Validation

An invalid component entry is skipped and reported as a warning; so are
duplicate ids and consumers that name no component. When the file is not JSON,
lacks a `components` array or keeps no valid component, Structured Review
reports why and infers components instead.

## Without a manifest

Each directory below the repository root that holds a project marker
(`package.json`, `tsconfig.json`, `pyproject.toml`, `setup.py`,
`requirements.txt`, `pom.xml`, `build.gradle`, a solution or project file) is a
component, deepest first. A file outside every such directory belongs to its
top-level directory, and a top-level file to `(repository root)`. Inferred
components have `normal` criticality and no contracts or consumers.

## Where it appears

- The diff pane shows the shape while no node is selected; **Shape of the
  change** in the plan header returns to it from the walk.
- `srev shape --session <id>` prints it as JSON, or as text with `--pretty`.
- `GET /api/sessions/:id/shape` serves it. It is computed from the working tree
  and the session's base on each request, so it reads the manifest as it is in
  the working tree.
