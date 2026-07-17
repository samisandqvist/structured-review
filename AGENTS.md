# Code Review Walkthrough

A code-structure-based review tool: Claude Code skill + local web UI. Walks a
reviewer through changes along the call/dependency graph instead of a file tree.

Design spec: `docs/superpowers/specs/2026-06-19-code-review-walkthrough-design.md`

## Stack

- **Runtime:** Node.js, pnpm workspaces monorepo
- **Server:** Hono + better-sqlite3 (local single-user, localhost, no auth)
- **Web:** Vite + React 19 + TypeScript, TanStack Query, Zustand, React Flow
- **Skill:** Claude Code skill markdown + TypeScript orchestration scripts
- **Graph:** CRG (code-review-graph) as external graph provider via a GraphProvider interface
- **Tests:** Vitest (all packages), Playwright (web UI E2E)

## Monorepo layout

```
packages/
  skill/     # Claude Code skill + superpowers glue
  server/    # Local review hub — Hono + better-sqlite3
  web/       # Vite + React UI
```

## Commands

```bash
pnpm install          # install deps across workspaces
pnpm dev              # start server + Vite concurrently
pnpm build            # build all packages (static UI served by hub)
pnpm test             # run Vitest across all packages
pnpm typecheck        # typecheck all packages
pnpm lint             # lint all packages
```

## Agent CLI (crw)

`crw` (built: `packages/skill/dist/cli.js`, bin of `@crw/skill`; dev:
`npx tsx packages/skill/src/cli.ts`) is the stable agent-facing surface for
setting up and harvesting reviews — no curl or direct SQLite access. JSON on
stdout; `--pretty` for humans.

```bash
crw serve [--repo <path>] [--port N]              # start or reuse the hub (checks /health repoRoot)
crw session create --branch <b> --base <ref>      # prints sessionId, uiUrl, counts, indexWarnings
crw context --session <id>                        # flows + orphans + change summaries for planning
crw plan --session <id> (--auto | --units <f>)    # mechanical or LLM-authored plan
crw diff --session <id> --node <stableId>         # single node diff
crw status --session <id>                         # coverage, per-unit reviewed/total, unreviewed
crw comments --session <id>                       # exported comments + review status (GitHub-mappable)
crw wait --session <id> [--until reviewed|commented]
```

## Graph provider (CRG)

Without `CRG_COMMAND` set, the server uses `StubGraphProvider` (3 fixed fake
nodes). For a real call graph, use [code-review-graph](https://github.com/tirth8205/code-review-graph),
a Python MCP server. One-time setup:

```bash
uv venv .venv-crg
uv pip install --python .venv-crg code-review-graph
.venv-crg/bin/code-review-graph build        # build the graph for this repo
```

Then run the hub with CRG enabled:

```bash
CRG_COMMAND="$PWD/.venv-crg/bin/code-review-graph serve" pnpm --filter @crw/server dev
```

`CrgGraphProvider` calls `get_impact_radius_tool` for the change subgraph
(changed nodes + ±`CRG_IMPACT_DEPTH`-hop context + `CALLS` edges, keyed by
qualified name) and `query_graph_tool` for callers/callees. Tuning envs:
`CRG_IMPACT_DEPTH` (default 1), `CRG_REPO_ROOT` (default git root),
`CRG_SKIP_BUILD` (skip the incremental rebuild on each session).

## Conventions

- TypeScript strict mode everywhere.
- Prefer small, well-bounded modules with clear interfaces.
- The server is the single hub: the web UI never reads CRG or git directly — it goes
  through the server.
- Graph providers plug in behind a `GraphProvider` interface; CRG is provider #1.
- The skill and the server are separate: the skill is the LLM/planning process and
  orchestrator; the server is the stateful backend the UI depends on.

## Out of scope (v1)

- Apply-fix / re-review loop (external — separate Claude Code run consumes comments)
- Message-flow edge provider (named extension point only)
- Nested units
