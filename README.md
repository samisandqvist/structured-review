# Code Review Walkthrough

A polyglot, coverage-guaranteed code review tool. It orders every changed
hunk of a diff by execution flow — walking a call graph instead of a file
tree — and tracks review coverage per unit so nothing changed goes unseen.
Supports **TypeScript, Python, and Java** in one session. **Status: alpha,
in active dogfooding.**

## Features

- **Execution-flow review plans.** Changes are grouped into ordered review
  units along traced call flows (entry point → callees), not directories.
  Flow trees are pruned to change-relevant paths; off-path callees collapse
  into expandable context runs.
- **Coverage as a contract.** Every changed node belongs to exactly one
  unit; anything a plan misses is swept into a visible "Unassigned changes"
  unit, and per-unit `reviewed/total` ledgers track progress to 100%.
- **Context attachments.** At plan submit, the server nests changed tests
  under the code they exercise (TESTED_BY edges or test-file imports),
  DTOs/types under their consumers (a file-level requires relation), and
  module-scope leftovers under their file's unit — so related changes are
  reviewed together, not as a pile of leftovers. Cross-unit tests appear
  once for real and as dimmed references elsewhere.
- **Residual coverage.** Changed lines outside any graph node (types,
  imports, configs, docs) become per-file pseudo-nodes with their exact
  ranges, so non-code changes still enter the review universe.
- **Line-anchored comments.** Comments anchor to diff line ranges with
  server-validated snippets; the export is GitHub-mappable (file, line
  range, side, hunk snippet, review status).
- **Agent CLI (`crw`).** The entire lifecycle is scriptable — start the
  hub, create sessions, build plans, poll status, wait for the reviewer,
  harvest comments — JSON on stdout, `--pretty` for humans.
- **Local web UI.** Graph and flow views, keyboard walk order (`j`/`k`
  next/prev, `n` next unreviewed, `r` mark reviewed), per-unit progress,
  bulk mark-reviewed, stale-session detection when the working tree moves
  under a session.
- **Honest degradation.** A missing language toolchain never fails silently:
  the session records per-language `indexWarnings`, the UI banners them, and
  affected files fall back to residual-only review.

## Language support

| Language | Indexer | Setup |
|---|---|---|
| TypeScript / JavaScript | `scip-typescript` | Bundled — nothing to install |
| Python | `scip-python` | Bundled — nothing to install |
| Java | `scip-java` | Needs coursier (`cs`) + JDK + Maven on PATH; without them Java degrades to residual-only with a visible warning |
| Rust | `rust-analyzer scip` | Planned (on hold) |

Mixed-language repos work: each detected language root is indexed
separately and merged into one session (e.g. a TS web app + Python service
+ Java backend in a single review).

## Install as a Claude Code plugin (recommended)

Requires **Node >= 22.13** and npm on PATH. In Claude Code:

```
/plugin marketplace add samisandqvist/structured-review
/plugin install code-review-walkthrough@crw
```

The first session start npm-installs the TypeScript/Python indexers into the
plugin data dir (give it a minute once). Then ask Claude to review a branch —
the `code-review-walkthrough` skill drives everything and hands you a local
web UI URL to walk the review. All state (DB, logs, indexers) lives under
`~/.claude/plugins/data/`, never in the reviewed repo.

Update later with `/plugin update code-review-walkthrough@crw` — every push
to main is a new version (commit-SHA versioning). Verified on Linux and
macOS; Windows is not supported. Maintainers: rebuild the committed bundle
with `pnpm build && pnpm build:plugin` before pushing runtime changes (CI
fails if you forget).

## Quick start (from source)

```bash
pnpm install
pnpm build
pnpm start
```

Then open `http://localhost:3456`. The CLI below opens this URL for you with
a session already attached (`?session=<id>`); visiting it directly without a
session query param loads no session data — create a session first.

**Development mode:** `pnpm dev` runs the server on `:3456` and Vite on
`:5173` (proxying `/api` to the server), with hot reload for the web UI.

## The crw CLI

```bash
node packages/skill/dist/cli.js <command>       # (the plugin runs the same CLI as `crw`)
```

```text
crw serve [--repo <path>] [--port N]            # start or reuse the hub for a repo
crw session create --branch <b> --base <ref> [--open]
crw context --session <id>                      # flows + orphans + change summaries for planning
crw plan --session <id> (--auto | --units <file.json>) [--open]
crw diff --session <id> --node <stableId>       # a single node's diff
crw status --session <id>                       # coverage, per-unit reviewed/total, unreviewed list
crw comments --session <id>                     # exported comments, GitHub-mappable
crw wait --session <id> [--until reviewed|commented] [--interval s] [--timeout s]
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
takes an LLM- or hand-authored plan instead — see
[`packages/skill/skill.md`](packages/skill/skill.md) for the plan schema
and authoring guidance.

`--branch` defaults to `HEAD`. If you pass an explicit branch name, it must
be the branch that is actually checked out — the server reviews the working
tree on disk, so a session for a branch that isn't checked out would
silently review the wrong code and is rejected with a 400 instead.

## Scope and contract

- A session reviews the current working tree vs. a resolved `baseRef`,
  including staged and unstaged changes — not just the last commit.
  Brand-new **untracked** files are not part of the diff universe yet.
- The session branch must be `HEAD` or the branch currently checked out.
- If HEAD moves or the working tree changes after a session is created, the
  UI and `crw status` flag the session stale — recreate it to pick up the
  new state.

## Providers and environment variables

| Variable | Default | Meaning |
|---|---|---|
| `GRAPH_PROVIDER` | `scip` | Graph source: `scip` (multi-language SCIP indexers, default), `crg` (external code-review-graph server), or `stub` (fixed fake graph for testing). |
| `CRW_DB_PATH` | `review.db` | Path to the local SQLite database file (built-in `node:sqlite`, no native deps). |
| `PORT` | `3456` | Port the server listens on. |
| `CRW_HOST` | `127.0.0.1` | Bind address. The API is unauthenticated; a warning is printed if you bind to anything other than `127.0.0.1`/`localhost`. |
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

## Comment export

`GET /api/sessions/:id/export` (or `crw comments`) returns:

```json
{
  "branch": "HEAD",
  "baseRef": "main",
  "headSha": "…",
  "comments": [ {
    "id": "…", "nodeId": "…", "stableId": "…", "label": "…",
    "file": "…", "startLine": 1, "endLine": 20,
    "anchor": { "startLine": 4, "startSide": "new", "endLine": 6, "endSide": "new" },
    "hunkSnippet": "…", "text": "…", "structuralContext": "…", "createdAt": 0
  } ]
}
```

`comments` is an ordered array (insertion order); a node with multiple
comments has multiple entries. `anchor` is the comment's diff line range
(`null` for whole-node comments) — with `file` it maps directly onto a
GitHub PR review comment. `hunkSnippet` is derived by the server when the
comment is created and validated against the node's current diff;
`structuralContext` is derived at export time from the session's call/test
edges. Both are server-owned — `POST /api/sessions/:id/comments` accepts
only `{ "nodeId", "text", "anchor?" }`. `crw comments` additionally joins
each comment with its node's current review status.

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

## Data & privacy

Everything runs locally. The server binds to loopback (`127.0.0.1`) by
default and has no authentication — do not bind it to a non-loopback address
on a shared or untrusted network. The database is a plain local SQLite file
(no native modules — Node's built-in `node:sqlite`); nothing is sent
anywhere. From source it lives at `CRW_DB_PATH` (default `review.db` in the
repo); as a plugin, under `~/.claude/plugins/data/`.

## Troubleshooting

- **Stale-session chip** ("repo moved since session start"): HEAD moved or
  the working tree changed after the session was created. Recreate the
  session.
- **Amber index-warnings banner / `indexWarnings` in session output**: a
  language was indexed in degraded mode (typically the scip-java toolchain
  missing). Install the named toolchain and recreate the session; until
  then those files are reviewable as residual pseudo-nodes only.
- **`crw requires Node >= 22.13`**: upgrade Node — the server uses the
  built-in `node:sqlite` driver.
- **`not a git repository (or git unavailable)`**: the server couldn't run
  git in the repo root — check you're in a git checkout and `git` is on
  `PATH`.
- **`cannot resolve base ref '<ref>'`**: the `--base` value doesn't resolve
  to a commit — check the ref name.
- **`session branch '<branch>' is not checked out ...`**: pass `HEAD` (the
  default) or check out the branch you named.
- **`port is occupied by ...`** (from `crw serve`): another hub (or another
  process) owns the port — pick a different `--port` or stop it.
- **`review database schema vN is newer than this application ...`**: the DB
  file was written by a newer version of this app. Upgrade the app, or
  delete/archive the database file (`CRW_DB_PATH`).
- **`web UI not built — run pnpm build`** (printed at server startup): the
  server didn't find a built SPA. Run `pnpm build` first.

## Learn more

- Design docs: [`docs/`](docs/) — architecture, provider comparisons, and
  implementation notes (see `docs/superpowers/specs/` for feature designs).
- Skill / plan authoring: [`packages/skill/skill.md`](packages/skill/skill.md).
- Contributing: [`AGENTS.md`](AGENTS.md) — stack, monorepo layout, and dev
  commands for anyone working on this repo.
