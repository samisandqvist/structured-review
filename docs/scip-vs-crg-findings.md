# SCIP provider experiment — findings

Prototype evaluation of **SCIP** (`scip-typescript`) as a replacement graph
provider for **CRG**, run on this repo. Goal: decide between SCIP, LSP, or
SCIP+LSP for a general multi-language review tool.

## How it was run
```bash
pnpm dlx @sourcegraph/scip-typescript index --infer-tsconfig --output index.scip   # 711 KB, ~1s
# decode index.scip via protobufjs + scip.proto; derive nodes + call edges
```
- **Node** = a global (non-local) definition occurrence whose symbol has an
  `enclosing_range` (a body span) and a term/method descriptor.
- **Call edge** = a non-definition, non-import reference to a node-symbol,
  attributed to the innermost named node whose `enclosing_range` contains it.

## Results (whole repo)

| | CRG (tree-sitter) | SCIP (scip-typescript) |
|---|---|---|
| Function/method nodes | 106 fn + 68 test (+3 class, +50 file) | 99 fn/method (8 test) |
| Unique CALLS edges | 637 | 98 |
| Source location spans | yes (`line_start/end`) | yes (`enclosing_range`) |
| Symbol `kind` (Function/Method) | yes | **no — not populated by scip-typescript 0.4.0** |
| Access | read its **internal SQLite** (MCP doesn't expose id→node/edges) | read a **documented protobuf** index file |
| Process model | live MCP server + build step + `CRG_SKIP_BUILD` | static index file (cacheable per commit) |
| Resolution | syntactic (tree-sitter) | semantic / type-aware |

Spot-check of `crg.ts` (matches the real code):
```
getNeighbors      -> callTool, mapQueryNodes
callTool          -> getClient
mapQueryNodes     -> isNoiseName, rel, isTestNode
isTestNode        -> isTestFile
getChangeSubgraph -> callTool, isNoiseName, rel, isTestNode
```

## What SCIP does better
- **Cleaner, semantic call edges.** Type-aware resolution; the spot-check is
  accurate. No coupling to a tool's internal DB — it's a versioned, documented
  format, and the index is a cacheable per-commit artifact (no live process).
- **Precise body spans** via `enclosing_range`.
- **Naturally coarser graph.** Anonymous callbacks / nested locals (`add`,
  `onUp`, each `it(...)`) are *not* separate nodes — they roll up into the
  enclosing named function. That removes exactly the noise we were filtering out
  of CRG by hand. The 637-vs-98 edge gap is mostly CRG counting test-case nodes,
  nested locals, and duplicate call sites.

## What SCIP costs / risks
- **No `kind` field** from scip-typescript → function detection is heuristic
  (term/method descriptor + has-body-span). Worked well here but could
  misclassify (e.g. object literals). Could be tightened or use newer indexers.
- **Call-vs-reference fuzz is real but small here.** SCIP doesn't tag a
  reference as "a call", so passing a function as a value / re-export could
  count as an edge. Filtering out definitions + imports + module-scope refs and
  attributing to the innermost enclosing function gave clean results.
- **Lost granularity for nested functions.** A genuinely-changed nested helper
  rolls into its parent (we filter those anyway, so likely fine).
- **Per-language indexer**, same as CRG's per-language story (scip-typescript,
  scip-python, scip-java, scip-go, rust-analyzer→scip, scip-clang, …).

## Recommendation
SCIP is a **better spine than CRG** for this tool: more precise call edges, a
stable decoupled format instead of reading a tool's private SQLite, a cacheable
static artifact that fits our batch session model, and a graph that's already
at the right altitude (no nested/test-callback noise). The two real gaps —
missing `kind` and call-vs-reference fuzz — are exactly the things **LSP call
hierarchy** resolves cleanly.

Suggested direction: **SCIP as the default**, with **LSP call hierarchy as an
optional precision booster / fallback** where an indexer is weak or call
disambiguation matters. I.e. SCIP+LSP, SCIP-first.

Next step if approved: implement a `ScipGraphProvider` behind the existing
`GraphProvider` interface (index on session create, cache per commit), and keep
CRG as a fallback while we validate other languages.

---

# LSP probe — does call hierarchy beat SCIP's derived edges?

Drove `typescript-language-server` headless (LSP `initialize` →
`documentSymbol` + `callHierarchy`) over `crg.ts` and compared its calls to the
SCIP-derived edges for the same functions.

**Setup confirmed:** `callHierarchyProvider: true`, `documentSymbol` returns
kinds.

**Gap 1 (kind) — only partly fixed.** LSP gives `Method` for methods, but
arrow-const functions (`const isNoiseName = () => …`) report as **`Constant`**,
not `Function`. So "is it a function?" still needs the same has-a-body /
is-callable heuristic — LSP `kind` helps but doesn't cleanly solve it.

**Gap 2 (call edges) — LSP is more complete but noisier, and needs the same
filtering.** `outgoingCalls` returns *every* call, including built-ins/library:

| function | LSP raw outgoing | LSP first-party (in-repo) | SCIP-derived |
|---|---|---|---|
| getNeighbors | all, all, callTool, mapQueryNodes | **callTool, mapQueryNodes** | callTool, mapQueryNodes |
| callTool | getClient, stringify, find, parse | **getClient** | getClient |
| isTestNode | isTestFile | **isTestFile** | isTestFile |
| getChangeSubgraph | callTool, add, has, push, map, filter, values | **callTool, add** | callTool, isNoiseName, rel, isTestNode |

`all` (better-sqlite3), `has/push/map/filter/values` (Map/Array), `stringify/
parse` (JSON), `trim` (string) are library calls — LSP includes them; you must
filter to in-repo targets. SCIP gets that filtering for free (it only counts
references to first-party function *nodes*).

**After first-party filtering, LSP ≈ SCIP.** The only real difference is
local-helper granularity: LSP shows `getChangeSubgraph → add` (a local arrow),
while SCIP rolls `add`'s calls up into `getChangeSubgraph`. Both defensible;
neither is "more correct" for our de-noised altitude.

**Cost:** LSP = multi-second project warm-up + a per-symbol crawl (prepare +
outgoing per node) + library filtering. SCIP = one index pass for the whole repo.

## Revised recommendation
The probe undercuts the abstract case for LSP. For **first-party call edges**,
SCIP-derived edges already match LSP's (after the filtering LSP also needs), and
LSP's theoretical edge (call-vs-reference disambiguation) produced no materially
cleaner graph here — at a real orchestration cost.

**Go SCIP-only for now.** Keep LSP in the back pocket as a targeted refinement
for specific cases (disambiguating a genuine call from a value-pass; languages
where the SCIP indexer is weak), not as a graph-wide booster we build today.
Revisit if we hit concrete accuracy gaps on real review sessions.
