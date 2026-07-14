# Code Review Walkthrough

A TypeScript-first, coverage-guaranteed code review tool. It orders every
changed hunk of a diff by execution flow — walking a call graph instead of a
file tree — and tracks review coverage per unit so nothing changed goes
unseen. **Status: alpha.**

## Quick start (production)

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
node packages/skill/dist/orchestrate.js --base main
```

This reviews the **current working tree** (staged and unstaged changes
included) against `--base` (default `main`), writes a deterministic plan (one
unit per affected execution flow, plus one catch-all unit for anything left
over), and opens the UI to that session.

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
{ "comments": [ { "id": "...", "nodeId": "...", "stableId": "...", "label": "...", "file": "...", "hunkSnippet": "...", "text": "...", "structuralContext": "...", "createdAt": 0 } ] }
```

`comments` is an ordered array (insertion order); a node with multiple
comments has multiple entries, one per comment.

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
