# Structured Review

A code-structure-based review tool: Claude Code / Codex skill + local web UI. Walks a
reviewer through changes along the call/dependency graph instead of a file tree.

Current design: [architecture](docs/architecture.md) and
[review model](docs/review-model.md). Candidate indexing work is recorded in
[indexing follow-ups](docs/indexing-follow-ups.md).

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

## Agent CLI (srev)

`srev` (built: `packages/skill/dist/cli.js`, bin of `@srev/skill`; dev:
`npx tsx packages/skill/src/cli.ts`) is the stable agent-facing surface for
setting up and harvesting reviews — no curl or direct SQLite access. JSON on
stdout; `--pretty` for humans.

```bash
srev serve [--repo <path>] [--port N]              # start or reuse the hub (checks /health repoRoot)
srev session create --branch <b> --base <ref|empty># prints sessionId, uiUrl, counts, indexWarnings; "empty" = whole-repo
srev context --session <id> [--brief|--full]       # planning view: commit subjects, flows + merge suggestions, orphan groups, change summaries (--brief: numeric refs, no stableIds)
srev plan --session <id> (--auto | --units <f>)    # mechanical or LLM-authored plan (flowIds/mergeGroup numeric refs, orphanFiles globs); always lists unassigned leftovers
srev diff --session <id> --node <stableId>         # single node diff
srev status --session <id>                         # coverage, overview, per-unit reviewed/total, unreviewed
srev comments --session <id>                       # exported comments + review status (GitHub-mappable)
srev wait --session <id> [--until reviewed|commented]
srev gc [--repo <path>] [--all]                    # remove a repo's DB/logs (stops the hub first)
srev shutdown                                      # stop the hub over HTTP
```

## Plugin packages

- `plugin/`: Claude Code package; marketplace at `.claude-plugin/marketplace.json`.
- `plugins/structured-review/`: Codex package; marketplace at `.agents/plugins/marketplace.json`.
- `scripts/build-plugin.mjs` generates both runtime bundles and skill copies from
  one source. `scripts/plugin-launcher.mjs` is copied into both packages and
  bootstraps indexers when needed; don't edit generated files.
- Rebuild with `pnpm build && pnpm build:plugin` after runtime or skill changes.
  CI checks freshness of both committed bundles.
- Node >= 22.13 is required. Plugin state uses the host data directory or the
  launcher's XDG data fallback, outside the reviewed repository.

## Graph providers

`GRAPH_PROVIDER=scip` is the default. It indexes the tracked working tree with
scip-typescript, scip-python, and (when available) scip-java and scip-dotnet. A
missing Java or .NET indexer toolchain is reported in `indexWarnings`; affected
text changes remain reviewable as residuals. SCIP relationships are inferred from references and
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

## Quality checks

Use [docs/harness.md](docs/harness.md) for the verification commands, strict targets,
source boundaries, and explicit transitional debt. `pnpm verify` is the local CI
entrypoint; `pnpm verify:strict` reports full strict debt, and `pnpm verify:full`
also runs selected mutation tests. Keep both plugin packages fresh with
`pnpm build && pnpm build:plugin` after runtime changes.

Use Semble for discovery, then read source and use exact references for impact.
Read current repository design/configuration docs for product and GraphProvider
contracts; designated QMD notes can provide context but may be historical.
Use version-matched official documentation for library behavior.

Keep functions at a consistent level of abstraction (Q-ABSTRACTION; details in
`docs/harness.md`). The harness does not add a product-spec/history maintenance
contract or the five deferred workflow practices.
