# Code Review Walkthrough

A TypeScript-first, coverage-guaranteed code review tool. It orders every
changed hunk of a diff by execution flow — walking a call graph instead of a
file tree — and tracks review coverage per unit so nothing changed goes
unseen. **Status: alpha.**

## Install as a Claude Code plugin (recommended)

Requires **Node >= 22.13** and npm on PATH. In Claude Code:

```
/plugin marketplace add samisandqvist/structured-review
/plugin install code-review-walkthrough@crw
```

The first session start npm-installs the TypeScript/Python indexers into the
plugin data dir (give it a minute once). Then ask Claude to review a branch —
the `code-review-walkthrough` skill drives everything and hands you a local
web UI URL to walk the review. Java additionally needs the scip-java
toolchain on PATH (coursier `cs` + JDK + Maven); without it Java changes
degrade to residual-only with a visible warning. All state (DB, logs,
indexers) lives under `~/.claude/plugins/data/`, never in the reviewed repo.

Update later with `/plugin update code-review-walkthrough@crw` — every push
to main is a new version (commit-SHA versioning). Maintainers: rebuild the
committed bundle with `pnpm build && pnpm build:plugin` before pushing
runtime changes.

## Quick start (from source)

```bash
pnpm install
pnpm build
pnpm start
```

Then open `http://localhost:3456`. The CLI in the next section opens this URL
for you with a session already attached (`?session=<id>`); visiting it
directly without a session query param loads no session data, so there's
nothing to review yet — create a session first.

## Create a review session

```bash
node packages/skill/dist/cli.js serve
node packages/skill/dist/cli.js session create --branch HEAD --base main
node packages/skill/dist/cli.js plan --session <id> --auto --open
```

This reviews the **current working tree** (staged and unstaged changes
included) against `--base`, writes a deterministic plan (one unit per
affected execution flow; tests/DTOs/residuals attach themselves to those
units at submit), and opens the UI to that session. Run
`node packages/skill/dist/cli.js` with no arguments for the full command
list (`context`, `diff`, `status`, `comments`, `wait`).

`--branch` defaults to `HEAD`. If you pass an explicit branch name, it must be
the branch that is actually checked out — the server reviews the working tree
on disk, so a session for a branch that isn't checked out would silently
review the wrong code and is rejected with a 400 instead.

**Development mode:** `pnpm dev` runs the server on `:3456` and Vite on
`:5173` (proxying `/api` to the server), with hot reload for the web UI.

## Scope and contract

- TypeScript only today — the default graph provider runs `scip-typescript`
  over the working tree. Other languages aren't supported yet.
- A session reviews the current working tree vs. a resolved `baseRef`,
  including staged and unstaged changes — not just the last commit.
- The session branch must be `HEAD` or the branch currently checked out.
- If HEAD moves or the working tree changes after a session is created, the
  UI shows a stale-session warning (see Troubleshooting) — recreate the
  session to pick up the new state.

## Providers and environment variables

| Variable | Default | Meaning |
|---|---|---|
| `GRAPH_PROVIDER` | `scip` | Graph source: `scip` (scip-typescript, default), `crg` (external code-review-graph server), or `stub` (fixed fake graph for testing). |
| `CRW_DB_PATH` | `review.db` | Path to the local SQLite database file. |
| `PORT` | `3456` | Port the server listens on. |
| `CRW_HOST` | `127.0.0.1` | Bind address. The API is unauthenticated; a warning is printed if you bind to anything other than `127.0.0.1`/`localhost`. |
| `CRW_WEB_DIST` | `packages/web/dist` (resolved relative to the server) | Path to the built web SPA the server serves as static files. |
| `CRW_SERVER_URL` | `http://localhost:3456` | Server URL the skill CLI (`orchestrate.js`) talks to. |
| `SCIP_CONTEXT_DEPTH` | `1` | (scip provider) How many call-graph hops of context to pull in around changed nodes. |
| `SCIP_NO_CACHE` | unset | (scip provider) Set to `1` to force a full re-index instead of using the cached SCIP index. |

A few more exist for advanced setups: `SCIP_REPO_ROOT` and `CRG_REPO_ROOT`
override the git root the respective provider reads from (default: the
ambient repo root), and `CRG_COMMAND` sets the command used to launch the
`crg` provider's server (default `code-review-graph serve`).

## Comment export

`GET /api/sessions/:id/export` returns:

```json
{
  "branch": "HEAD",
  "baseRef": "main",
  "headSha": "…",
  "comments": [ { "id": "…", "nodeId": "…", "stableId": "…", "label": "…", "file": "…", "startLine": 1, "endLine": 20, "hunkSnippet": "…", "text": "…", "structuralContext": "…", "createdAt": 0 } ]
}
```

`comments` is an ordered array (insertion order); a node with multiple
comments has multiple entries, one per comment. `hunkSnippet` is derived by
the server when the comment is created (the bounded changed fragment shown
for the node, with real file line numbers); `structuralContext` is derived
at export time from the session's call/test edges. Both are server-owned —
`POST /api/sessions/:id/comments` accepts only `{ "nodeId": "…", "text": "…" }`.

## Entry-point configuration

Flow entry points are inferred from the call graph (functions nothing else
calls) and scored: an explicit configuration scores 1.0, an exported graph
root 0.7, a bare graph root 0.4. The flows API reports the evidence per flow
as `entryReasons` (`graph-root` / `exported` / `configured`) and
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
(`CRW_DB_PATH`, default `review.db`); nothing is sent anywhere.

## Troubleshooting

- **Stale-session chip** ("repo moved since session start"): HEAD moved or
  the working tree changed after the session was created. Recreate the
  session.
- **`not a git repository (or git unavailable)`**: the server couldn't run
  git in the repo root — check you're in a git checkout and `git` is on
  `PATH`.
- **`cannot resolve base ref '<ref>'`**: the `--base` value doesn't resolve
  to a commit — check the ref name.
- **`session branch '<branch>' is not checked out ...`**: pass `HEAD` (the
  default) or check out the branch you named.
- **`review database schema vN is newer than this application ...`**: the DB
  file was written by a newer version of this app. Upgrade the app, or
  delete/archive the database file (`CRW_DB_PATH`).
- **`web UI not built — run pnpm build`** (printed at server startup): the
  server didn't find `packages/web/dist/index.html`. Run `pnpm build` first.

## Learn more

- Design docs: [`docs/`](docs/) — architecture, provider comparisons, and
  implementation notes.
- Contributing: [`AGENTS.md`](AGENTS.md) — stack, monorepo layout, and dev
  commands for anyone working on this repo.
