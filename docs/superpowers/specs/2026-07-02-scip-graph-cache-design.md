# SCIP graph cache: index once per repo state, not once per request

Date: 2026-07-02
Status: proposed (awaiting review)

## Problem

`ScipGraphProvider.buildGraph()` has no memoization. Every call —
`getChangeSubgraph` at session creation, **every `getNeighbors` click** in the
node detail pane, every `getFlows` — re-runs `scip-typescript index` over the
entire repo (`packages/server/src/graph/scip.ts`). On this repo that is ~1s per
call; on a real target repo it is many seconds of UI latency per navigation.
The SCIP findings doc already prescribed the fix ("a cacheable per-commit
artifact") — it just was never wired in.

## Design

In-memory, single-entry cache on the provider instance, keyed by repo state:

```
private cache?: { key: string; graph: BuiltGraph };
```

**Key** = `git rev-parse HEAD` + `\n` + `git status --porcelain` output
(hashed). HEAD covers commits; the porcelain output covers uncommitted edits —
any file save that could change the graph changes the key. Both commands are
milliseconds against the multi-second index run. New private
`repoStateKey(): string` using `execFileSync` like the rest of the provider.

`buildGraph()` becomes:

1. `key = repoStateKey()`
2. cache hit (`cache.key === key`) → return `cache.graph`
3. miss → index as today, store `{ key, graph }`, return

Single entry suffices: the server is a local single-user hub and sessions
review one repo state at a time; holding older graphs has no use case.
`BuiltGraph` is a few maps of strings — memory is a non-issue.

**Concurrency:** two overlapping calls (e.g. session create fires
`getChangeSubgraph` while the UI fires `getNeighbors`) must not both index.
Store the in-flight promise, not just the result:
`cache: { key, graph: Promise<BuiltGraph> }` — second caller awaits the same
promise. A rejected promise clears the cache entry so the next call retries.

**Escape hatch:** `SCIP_NO_CACHE=1` env bypasses the cache (debugging indexer
issues), mirroring the existing `SCIP_*` tuning envs.

No `GraphProvider` interface change; CRG and stub providers are untouched
(CRG has its own build/`CRG_SKIP_BUILD` story).

## Edge cases

- **Repo edited mid-review** (fix applied while walking): next call re-keys and
  re-indexes automatically — the cache can never serve a stale graph, only a
  stale *session* can exist (covered by the stale-session indicator in the
  review-walk DX spec).
- **Untracked noise** (log files, `.playwright-mcp/`): porcelain includes
  untracked files, so touching them invalidates needlessly. Accepted: a spare
  re-index is the safe failure direction. (If it proves annoying, narrow to
  tracked files with `git status --porcelain -uno` — decide during
  implementation based on real noise.)
- **`git` failure** in `repoStateKey`: fall back to a fresh build (treat as
  cache miss), never throw from key computation.

## Testing

- Two sequential `getNeighbors` calls → indexer invoked once (inject a
  counting fake for the exec seam; refactor `buildGraph`'s exec call behind an
  injectable function if needed for testability).
- Key change (commit or dirty file in fixture repo) → re-index.
- Concurrent calls during a miss → one index run, both resolve.
- Failed index run → cache empty, next call retries.
- `SCIP_NO_CACHE=1` → indexer invoked per call.

## Out of scope

- Persisting the SCIP index or `BuiltGraph` to disk across server restarts.
- Multi-entry cache (multiple repo states).
- Caching for the CRG provider.
