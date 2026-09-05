# Code Review Walkthrough

A code-structure-based review tool: Claude Code / Codex skill + local web UI. Walks a
reviewer through changes along the call/dependency graph instead of a file tree.

Design spec: `docs/superpowers/specs/2026-06-19-code-review-walkthrough-design.md`

## Stack

- **Runtime:** Node.js, pnpm workspaces monorepo
- **Server:** Hono + Node built-in `node:sqlite` (local single-user, localhost, no auth)
- **Web:** Vite + React 19 + TypeScript, TanStack Query, Zustand
- **Skill:** Claude Code skill markdown + TypeScript orchestration scripts
- **Graph:** SCIP indexers (TypeScript, Python, Java) behind a GraphProvider interface; CRG and stub alternatives
- **Tests:** Vitest unit, React component, and real-indexer integration tests

## Monorepo layout

```
packages/
  skill/     # Claude Code skill + superpowers glue
  server/    # Local review hub — Hono + Node built-in `node:sqlite`
  web/       # Vite + React UI
```

## Commands

```bash
pnpm install          # install deps across workspaces
pnpm dev              # start server + Vite concurrently
pnpm build            # build all packages (static UI served by hub)
pnpm test             # run Vitest across all packages
pnpm typecheck        # typecheck all packages
pnpm build:plugin     # regenerate both committed plugin packages
pnpm demo             # disposable example review; build first
```

## Agent CLI (crw)

`crw` (built: `packages/skill/dist/cli.js`, bin of `@crw/skill`; dev:
`npx tsx packages/skill/src/cli.ts`) is the stable agent-facing surface for
setting up and harvesting reviews — no curl or direct SQLite access. JSON on
stdout; `--pretty` for humans.

```bash
crw serve [--repo <path>] [--port N]              # start or reuse the hub (checks /health repoRoot)
crw session create --branch <b> --base <ref|empty># prints sessionId, uiUrl, counts, indexWarnings; "empty" = whole-repo
crw context --session <id> [--brief|--full]       # planning view: commit subjects, flows + merge suggestions, orphan groups, change summaries (--brief: numeric refs, no stableIds)
crw plan --session <id> (--auto | --units <f>)    # mechanical or LLM-authored plan (flowIds/mergeGroup numeric refs, orphanFiles globs); always lists unassigned leftovers
crw diff --session <id> --node <stableId>         # single node diff
crw status --session <id>                         # coverage, overview, per-unit reviewed/total, unreviewed
crw comments --session <id>                       # exported comments + review status (GitHub-mappable)
crw wait --session <id> [--until reviewed|commented]
crw gc [--repo <path>] [--all]                    # remove a repo's DB/logs (stops the hub first)
crw shutdown                                      # stop the hub over HTTP
```

## Plugin packages

- `plugin/`: Claude Code package; marketplace at `.claude-plugin/marketplace.json`.
- `plugins/code-review-walkthrough/`: Codex package; marketplace at `.agents/plugins/marketplace.json`.
- `scripts/build-plugin.mjs` generates both runtime bundles and skill copies from
  one source. `scripts/plugin-launcher.mjs` is copied into both packages and
  bootstraps indexers when needed; don't edit generated files.
- Rebuild with `pnpm build && pnpm build:plugin` after runtime or skill changes.
  CI checks freshness of both committed bundles.
- Node >= 22.13 is required. Plugin state uses the host data directory or the
  launcher's XDG data fallback, outside the reviewed repository.

## Graph providers

`GRAPH_PROVIDER=scip` is the default. It indexes the tracked working tree with
scip-typescript, scip-python, and (when available) scip-java. A missing Java
compiler toolchain is reported in `indexWarnings`; affected text changes remain
reviewable as residuals. SCIP relationships are inferred from references and
are not execution traces.

`GRAPH_PROVIDER=crg` selects the external code-review-graph provider;
`CRG_COMMAND` chooses its launch command. `GRAPH_PROVIDER=stub` is for tests.
See [CLI and configuration](docs/cli-and-configuration.md) for setup and tuning.

## Conventions

- TypeScript strict mode everywhere.
- Prefer small, well-bounded modules with clear interfaces.
- The server is the single hub: the web UI never reads CRG or git directly — it goes
  through the server.
- Graph providers plug in behind a `GraphProvider` interface; SCIP is the default provider.
- The skill and the server are separate: the skill is the LLM/planning process and
  orchestrator; the server is the stateful backend the UI depends on.

## Out of scope (v1)

- Apply-fix / re-review loop (external — separate Claude Code run consumes comments)
- Message-flow edge provider (named extension point only)
- Nested units
