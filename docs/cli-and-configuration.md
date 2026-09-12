# CLI and configuration reference

For installation and a first review, see the [README](../README.md).

## The crw CLI

```bash
node packages/skill/dist/cli.js <command>       # (the plugin runs the same CLI as `crw`)
```

```text
crw serve [--repo <path>] [--port N]            # start or reuse the hub for a repo
crw session create --branch <b> --base <ref|empty> [--open]   # "empty" = whole-repo review
crw session list
crw session delete --session <id>
crw context --session <id> [--brief|--full]     # planning view: commit subjects, flows + merge suggestions, orphan groups, change summaries (--brief: no stableIds, numeric refs only; --full: raw dump)
crw plan --session <id> (--auto | --units <file.json>) [--open]
crw diff --session <id> --node <stableId>       # a single node's diff
crw status --session <id>                       # coverage, overview, per-unit reviewed/total, unreviewed list
crw comments --session <id>                     # exported comments, GitHub-mappable
crw wait --session <id> [--until reviewed|commented] [--interval s] [--timeout s]
crw gc [--repo <path>] [--all]                  # remove a repo's DB/logs (stops the hub first)
crw shutdown                                    # stop the hub (state stays; serve restarts it)
```

Every command prints JSON on stdout (`--pretty` for humans). A typical
session:

```bash
node packages/skill/dist/cli.js serve
node packages/skill/dist/cli.js session create --branch HEAD --base main
node packages/skill/dist/cli.js plan --session <id> --auto --open
```

This reviews the **current working tree** (staged and unstaged changes
included) against `--base`, writes a deterministic plan (one unit per
affected execution flow; tests/DTOs/residuals attach themselves to those
units at submit), and opens the UI to that session. `crw plan --units`
takes an LLM- or hand-authored plan instead — a
`{ "overview": "...", "units": [...] }` file (bare units array also
accepted). Flow units can reference flows by the numeric ids the context
prints (`"flowIds": [127]`, `"mergeGroup": 0`) instead of transcribing
SCIP stableIds, and orphan units can claim files by glob
(`"orphanFiles": ["docs/**"]`, dotfiles included); the response always
lists unassigned leftovers (`[]` at full coverage) so the plan can be
fixed and re-submitted. See
[`packages/skill/skill.md`](../packages/skill/skill.md) for the plan schema
and authoring guidance.

`--branch` defaults to `HEAD`. If you pass an explicit branch name, it must
be the branch that is actually checked out — the server reviews the working
tree on disk, so a session for a branch that isn't checked out would
silently review the wrong code and is rejected with a 400 instead.

## Scope and contract

- A session reviews the current working tree vs. the supplied `baseRef`,
  including staged and unstaged changes — not just the last commit.
  Brand-new **untracked** files are not part of the diff universe yet.
- The session branch must be `HEAD` or the branch currently checked out.
- If HEAD moves or the working tree changes after a session is created, the
  UI and `crw status` flag the session stale — recreate it to pick up the
  new state.

Review marks cover represented changed text items, not every Git metadata change
or proof of correctness. See the [README's limits](../README.md#what-the-review-includes).

## Providers and environment variables

| Variable | Default | Meaning |
|---|---|---|
| `GRAPH_PROVIDER` | `scip` | Graph source: `scip` (multi-language SCIP indexers, default), `crg` (external code-review-graph server), or `stub` (fixed fake graph for testing). |
| `CRW_DB_PATH` | `review.db` | Path to the local SQLite database file (built-in `node:sqlite`, no native deps). |
| `PORT` | `3456` | Port the server listens on. |
| `CRW_HOST` | `127.0.0.1` | Bind address. Keep it loopback-only: the API has no authentication and rejects request hosts other than `localhost`, `127.0.0.1`, or `[::1]`. |
| `CRW_WEB_DIST` | auto | Path to the built web SPA. Auto-resolved for both the monorepo and plugin-bundle layouts. |
| `CRW_SERVER_URL` | `http://localhost:3456` | Hub URL the `crw` CLI talks to (or pass `--port`). |
| `CRW_DATA_DIR` | unset | Plugin mode: root for per-repo DBs and logs (keyed by repo name + path hash). Unset = state lands in the repo (`review.db`, `.crw/`). |
| `CRW_INDEXER_HOME` | unset | Plugin mode: directory whose `node_modules` holds the scip indexers. Unset = resolve from the app's own dependencies. |
| `SCIP_CONTEXT_DEPTH` | `1` | (scip) Call-graph hops of context around changed nodes. |
| `SCIP_NO_CACHE` | unset | (scip) Set to `1` to force a full re-index instead of using cached per-root indexes. |
| `SCIP_JAVA_CMD` | unset | (scip) Explicit scip-java launcher, overriding PATH detection of `scip-java`/`cs`. |
| `SCIP_JAVA_VERSION` | `0.12.3` | (scip) scip-java version used when launching via coursier. |

A few more exist for advanced setups: `SCIP_REPO_ROOT` and `CRG_REPO_ROOT`
override the git root the respective provider reads from (default: the
ambient repo root), and `CRG_COMMAND` sets the command used to launch the
`crg` provider's server (default `code-review-graph serve`).

The browser must use the same origin (scheme, host, and port) as its requests.
The Vite development proxy preserves that origin. Foreign Origins, including
`null`, and `Sec-Fetch-Site: cross-site` requests receive HTTP 403, including on
health and shutdown routes. CLI clients need no Origin header. JSON write routes
require `Content-Type: application/json` (optional charset allowed) or return
HTTP 415; bodyless shutdown and DELETE requests do not need a content type.

## Comment export

`GET /api/sessions/:id/export` (or `crw comments`) returns:

```json
{
  "branch": "HEAD",
  "baseRef": "main",
  "headSha": "…",
  "overview": "…",
  "comments": [ {
    "id": "…", "nodeId": "…", "stableId": "…", "label": "…",
    "file": "…", "startLine": 1, "endLine": 20,
    "anchor": { "startLine": 4, "startSide": "new", "endLine": 6, "endSide": "new" },
    "hunkSnippet": "…", "text": "…", "structuralContext": "…", "createdAt": 0
  } ]
}
```

`overview` is the plan's session narrative (`""` when the plan carries
none) — prepend it to a PR review body if exporting there. `comments` is an
ordered array (insertion order); a node with multiple
comments has multiple entries. `anchor` is the comment's diff line range
(`null` for whole-node comments) — with `file` it maps directly onto a
GitHub PR review comment. `hunkSnippet` is derived by the server when the
comment is created and validated against the node's current diff;
`structuralContext` is derived at export time from the session's call/test
edges. Both are server-owned — `POST /api/sessions/:id/comments` accepts
only `{ "nodeId", "text", "anchor?" }`. `PATCH /api/sessions/:id/comments/:commentId`
accepts `{ "text" }` and leaves the anchor and snippet as they are;
`DELETE /api/sessions/:id/comments/:commentId` removes the comment and, when it
was the node's last one, moves a `reviewed-commented` node back to
`reviewed-clean`. `crw comments` additionally joins each comment with its
node's current review status.

## Entry-point configuration

Flow entry points are inferred from the call graph (functions nothing else
calls) plus per-language evidence (exports, `main` guards), and scored: an
explicit configuration scores 1.0, an exported graph root 0.7, a bare graph
root 0.4. The flows API reports the evidence per flow as `entryReasons`
(`graph-root` / `exported` / `configured` / detected reasons) and
`entryConfidence`; the plan view shows the score on each flow unit.

Framework-registered entry points (HTTP routes, CLI commands, event
handlers) often have callers in the graph and are missed by inference —
declare them in `.crw-entry-points.json` at the repository root:

```json
{ "entryPoints": [ { "label": "main", "file": "src/cli.ts" } ] }
```

`label` matches the function name exactly; `file` (optional) must equal or
suffix-match the file path. Configured entries head flows even when the
graph shows callers.
