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
