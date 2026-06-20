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
