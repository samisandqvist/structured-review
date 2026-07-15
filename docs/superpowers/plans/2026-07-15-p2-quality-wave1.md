# P2 Quality Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement P2 roadmap items 1–3 from `docs/software-viability-usability-implementation-findings.md`: entry-point provenance + confidence, exact residual ranges instead of one bounding box per file, and atomic bulk review mutations with SQLite transactions.

**Architecture:** Residual pseudo-nodes keep their one-chip-per-file identity but store the exact residual `LineRange[]` in a new nullable `nodes.residual_ranges` column (migration v3); the node-detail diff is then assembled per range via the existing `extractHunkDiff` clipping, so hunks already covered by function nodes never re-render. Entry-point detection stays SCIP-side but gains evidence: a flow's entry now reports *why* it heads a flow (`graph-root` / `exported` / `configured`) with a deterministic confidence score, sourced from the call graph, the `export` keyword at the definition line, and an optional `.crw-entry-points.json`. Bulk review updates become one `PATCH /api/sessions/:id/nodes` request executed in a single better-sqlite3 transaction (all-or-nothing, per-node comment normalization preserved), and the two existing multi-write routes (session creation, plan replacement) are wrapped in transactions with the edge-insert node lookup switched to a `Map`.

**Tech Stack:** TypeScript ESM (`.js` import suffixes), Hono, better-sqlite3 (synchronous `db.transaction`), zod 4, React 19, @tanstack/react-query, Vitest 3.

## Global Constraints

- Package manager is **pnpm**. Run `pnpm test` from the repo root (all three packages; currently **172 tests / 20 files, all green** — must stay green plus new tests). `pnpm typecheck` clean.
- Work on branch **`feat/p2-quality`** off `main` (create it in Task 1 Step 1).
- All source imports use ESM `.js` suffixes.
- Server DTO changes must be hand-mirrored in `packages/web/src/api/client.ts` (repo convention — no shared package).
- Schema changes go through `PRAGMA user_version` migrations in `packages/server/src/db/schema.ts` (`SCHEMA_VERSION`, `MIGRATIONS`); new columns are added by ALTER, never edited into `SCHEMA_SQL` (v1 baseline stays frozen; fresh DBs run 0→1→2→3).
- Runtime validation: every new mutating route body gets a zod schema in `packages/server/src/validate.ts` and the `parseBody` helper (400 `{ error: "validation failed", issues }`).
- `packages/skill` reads flows/changes/export but must not be modified.
- Commit messages: conventional, each ending with the line `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Server + web — exact residual ranges

**Files:**
- Modify: `packages/server/src/residuals.ts` (add `ranges` to `ResidualNode`)
- Modify: `packages/server/src/db/schema.ts:61-71` (v3 migration), `packages/server/src/types.ts` (`Node.residualRanges`), `packages/server/src/repo/nodes.ts` (column round-trip)
- Modify: `packages/server/src/diff.ts` (add `getNodeDiffForRanges`), `packages/server/src/routes/nodes.ts:24-34` (use it), `packages/server/src/routes/sessions.ts:116-123` (pass ranges)
- Modify: `packages/web/src/api/client.ts` (mirror `LineRange`, `Node.residualRanges`)
- Test: `packages/server/test/residuals.test.ts`, `packages/server/test/diff.test.ts`, `packages/server/test/schema.test.ts`, `packages/server/test/routes.test.ts`

**Interfaces:**
- Consumes: `subtractRanges(ranges, spans): LineRange[]` (`diff.ts:169`, output disjoint), `extractHunkDiff(rawDiff, startLine, endLine): NodeDiff | null` (clips to the span — context lines outside [start,end] are excluded, which is what prevents re-showing covered hunks), `withTexts(lines)` (private in diff.ts, reuse internally).
- Produces: `ResidualNode.ranges: LineRange[]` (sorted by start); `Node.residualRanges: LineRange[] | null`; `createNode(db, node)` accepts optional `residualRanges` (defaults null); `getNodeDiffForRanges(baseRef, file, ranges, root?): NodeDiff | null`. Task 3's bulk repo function reuses `getNode`/`rowToNode` untouched semantics.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/p2-quality main
```

- [ ] **Step 2: Write the failing tests.**

In `packages/server/test/residuals.test.ts` (read the file first; it builds temp git fixture repos — follow its existing fixture helpers exactly), extend the existing multi-range scenario (or add one: a file where lines change above AND below a stored node span) with:

```ts
it("returns the exact residual ranges, not just the bounding box", () => {
  // fixture: file with changes at lines ~2-3 and ~40-41, node span covering 10-30
  const residuals = computeResiduals(baseRef, new Map([[file, [{ start: 10, end: 30 }]]]), root);
  expect(residuals).toHaveLength(1);
  expect(residuals[0].ranges).toEqual([
    { start: 2, end: 3 },
    { start: 40, end: 41 },
  ]); // adapt exact numbers to the fixture edit you make
  expect(residuals[0].startLine).toBe(2);   // bounding box preserved
  expect(residuals[0].endLine).toBe(41);
});
```

In `packages/server/test/diff.test.ts`:

```ts
describe("getNodeDiffForRanges", () => {
  // Synthetic diff: hunk 1 touches lines 2-3 (residual), hunk 2 touches
  // lines 10-12 (covered by a function node), hunk 3 touches lines 40-41 (residual).
  const raw = [
    "diff --git a/f.ts b/f.ts",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -2,2 +2,2 @@",
    "-old two",
    "+new two",
    " ctx three",
    "@@ -10,3 +10,3 @@",
    " fn body a",
    "-fn old",
    "+fn new",
    " fn body b",
    "@@ -40,2 +40,2 @@",
    " ctx forty",
    "-old fortyone",
    "+new fortyone",
  ].join("\n");

  it("includes only the given ranges, excluding covered function hunks", () => {
    // NOTE: this test calls the git-free core; see implementation step — the
    // exported helper extractLinesForRanges is pure, getNodeDiffForRanges shells git.
    const d = extractLinesForRanges(raw, [{ start: 2, end: 3 }, { start: 40, end: 41 }])!;
    const texts = d.lines.map((l) => l.text);
    expect(texts).toContain("new two");
    expect(texts).toContain("new fortyone");
    expect(texts).not.toContain("fn new");
    expect(texts).not.toContain("fn old");
  });

  it("keeps real coordinates so the renderer shows a gap between fragments", () => {
    const d = extractLinesForRanges(raw, [{ start: 2, end: 3 }, { start: 40, end: 41 }])!;
    const newLines = d.lines.map((l) => l.newLine).filter((n): n is number => n !== null);
    expect(Math.max(...newLines) - Math.min(...newLines)).toBeGreaterThan(30);
  });

  it("returns null when no range matches", () => {
    expect(extractLinesForRanges(raw, [{ start: 100, end: 110 }])).toBeNull();
  });
});
```

In `packages/server/test/schema.test.ts` (follow its existing migration-test pattern): a v2 database (create tables via MIGRATIONS[1] + MIGRATIONS[2], set `user_version = 2`) migrates to v3 and `nodes.residual_ranges` exists and is NULL for existing rows.

In `packages/server/test/routes.test.ts`: extend an existing session-creation test (or add one) so a residual node round-trips: after POST /api/sessions on a fixture repo with an uncovered change, GET the residual node from `/nodes` and assert `node.residualRanges` is a nonempty array of `{start, end}` objects.

- [ ] **Step 3: Run to verify failure** — `pnpm --filter @crw/server test`. Expected: FAIL (`ranges`/`extractLinesForRanges`/`residualRanges` don't exist; schema v3 missing).

- [ ] **Step 4: Implement.**

`packages/server/src/db/schema.ts`: bump `SCHEMA_VERSION = 3`, add:

```ts
  3: `ALTER TABLE nodes ADD COLUMN residual_ranges TEXT;`,
```

`packages/server/src/types.ts`: add after the `EdgeType` line:

```ts
export interface LineRange {
  start: number;
  end: number;
}
```

and to `Node` (after `isTest`): `residualRanges: LineRange[] | null;`. In `packages/server/src/diff.ts`, delete its local `LineRange` declaration and replace with `export type { LineRange } from "./types.js"`-style re-export **only if** diff.ts's `LineRange` is exported today (it is — `export interface LineRange` at ~line 25): change diff.ts to `import type { LineRange } from "./types.js";` + `export type { LineRange };` so existing importers (`residuals.ts`, `routes/sessions.ts`) keep compiling unchanged.

`packages/server/src/residuals.ts`: add `ranges: LineRange[];` to `ResidualNode`; in `computeResiduals` push:

```ts
    const sorted = residual.slice().sort((a, b) => a.start - b.start);
    out.push({
      stableId: `file-residual:${file}`,
      label: `${basename(file)}${suffix}`,
      file,
      startLine: start,
      endLine: end,
      isTest: isTestFile(file),
      ranges: sorted,
    });
```

`packages/server/src/repo/nodes.ts`:
- `NodeRow` gains `residual_ranges: string | null;`
- `rowToNode` gains `residualRanges: row.residual_ranges ? (JSON.parse(row.residual_ranges) as LineRange[]) : null,` (import `LineRange` type from `../types.js`)
- `createNode` signature becomes:

```ts
export function createNode(
  db: DB,
  node: Omit<Node, "id" | "residualRanges"> & { residualRanges?: LineRange[] | null }
): Node {
  const id = randomId("node");
  const residualRanges = node.residualRanges ?? null;
  db.prepare(
    `INSERT INTO nodes (id, session_id, stable_id, label, file, start_line, end_line, change_status, review_status, reviewed_in_unit, is_test, residual_ranges)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, node.sessionId, node.stableId, node.label, node.file,
    node.startLine, node.endLine, node.changeStatus, node.reviewStatus, node.reviewedInUnit, node.isTest ? 1 : 0,
    residualRanges ? JSON.stringify(residualRanges) : null);
  return { ...node, id, residualRanges };
}
```

`packages/server/src/diff.ts` — split pure core from git shell so it's testable:

```ts
/** DiffLines for several disjoint new-file ranges of one file's unified diff.
 *  Each range is clipped exactly (extractHunkDiff), so hunks inside covered
 *  node spans never leak in. Null when nothing falls in any range. */
export function extractLinesForRanges(rawDiff: string, ranges: LineRange[]): NodeDiff | null {
  const lines: DiffLine[] = [];
  for (const r of ranges) {
    const d = extractHunkDiff(rawDiff, r.start, r.end);
    if (d) lines.push(...d.lines);
  }
  if (lines.length === 0) return null;
  return withTexts(lines);
}

/** Diff for a residual pseudo-node: only its exact residual ranges. */
export function getNodeDiffForRanges(
  baseRef: string,
  file: string,
  ranges: LineRange[],
  root: string = repoRoot()
): NodeDiff | null {
  let raw: string;
  try {
    raw = execFileSync("git", ["diff", "--text", "--unified=3", baseRef, "--", file], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      ...QUIET,
    });
  } catch {
    return null;
  }
  return extractLinesForRanges(raw, ranges);
}
```

`packages/server/src/routes/sessions.ts` residual insert (~line 116): add `residualRanges: r.ranges,` to the `createNode` call for residuals (graph-node inserts stay unchanged — default null).

`packages/server/src/routes/nodes.ts` node-detail (~line 30):

```ts
    const diff = session
      ? (node.residualRanges && node.residualRanges.length > 0
          ? getNodeDiffForRanges(session.baseRef, node.file, node.residualRanges, ctx.repoRoot) ??
            getNodeDiff(session.baseRef, node.file, node.startLine, node.endLine, node.changeStatus, ctx.repoRoot)
          : getNodeDiff(session.baseRef, node.file, node.startLine, node.endLine, node.changeStatus, ctx.repoRoot))
      : { oldText: "", newText: "", lines: [] };
```

(the `??` fallback covers a stale session whose ranges no longer match any hunk — degrade to the old bounding-box slice rather than an empty pane).

`packages/web/src/api/client.ts`: add

```ts
export interface LineRange { start: number; end: number; }
```

and to `Node`: `residualRanges?: LineRange[] | null;`. No component changes: `DiffView`'s `withSeparators` already renders a `⋯` gap row between discontinuous fragments.

- [ ] **Step 5: Run tests** — `pnpm test && pnpm typecheck`. Expected: PASS (existing residuals tests keep passing — bounding box `startLine`/`endLine` unchanged).

- [ ] **Step 6: Commit**

```bash
git add packages/server packages/web
git commit -m "feat(server): exact residual ranges (schema v3) with range-clipped residual diffs"
```

---

### Task 2: Server + web — entry-point provenance and confidence

**Files:**
- Create: `packages/server/src/graph/entry-points.ts`
- Modify: `packages/server/src/graph/provider.ts` (Flow fields), `packages/server/src/graph/flow-tree.ts:86-88` (`makeFlow` evidence param), `packages/server/src/graph/scip.ts:166-188` (`getFlows`), `packages/server/src/routes/flows.ts:36-41` (pass through + sort)
- Modify: `packages/web/src/api/client.ts` (Flow fields), `packages/web/src/components/PlanView.tsx` (confidence chip on flow units)
- Test: `packages/server/test/graph.test.ts` (or a new `entry-points.test.ts`), `packages/server/test/e2e.test.ts`, `packages/web/test/PlanView.test.tsx`

**Interfaces:**
- Consumes: `BuiltGraph` internals in scip.ts (`g.nodes: Map<string, RawNode>` with `label/file/startLine/isTest`, `g.callAdj`, `g.callRev`), `makeFlow(id, name, steps)` from flow-tree.
- Produces:

```ts
// entry-points.ts
export type EntryReason = "graph-root" | "exported" | "configured";
export interface EntryEvidence { reasons: EntryReason[]; confidence: number; }
export interface ConfiguredEntry { label: string; file?: string; }
export function loadConfiguredEntries(root: string): ConfiguredEntry[];
export function isExportedAt(root: string, file: string, startLine: number, cache?: Map<string, string[]>): boolean;
export function entryEvidence(flags: { isRoot: boolean; isExported: boolean; isConfigured: boolean }): EntryEvidence;
```

  `Flow` (provider.ts) gains `entryReasons?: string[]; entryConfidence?: number;` (optional — CRG's `readFlows` path may not set them; the flows route defaults). `makeFlow(id, name, steps, evidence?)` fills them (defaults `["graph-root"]` / `0.4`). Flows route response flows gain required `entryReasons: string[]` and `entryConfidence: number`.

Confidence model (deterministic, documented in code):
- `configured` → **1.0** (explicit user intent beats inference)
- `graph-root` + `exported` → **0.7** (root that is also a module export — likely a real external entry)
- `graph-root` only → **0.4** (could be an internal utility the indexer sees no callers for)
- reasons listed in the fixed order `graph-root`, `exported`, `configured`.

Configured entries file: **`.crw-entry-points.json`** at the provider's repo root:

```json
{ "entryPoints": [ { "label": "main", "file": "src/cli.ts" } ] }
```

`label` matches the node label exactly; optional `file` must equal the node's file or be a suffix of it. A configured symbol heads a flow even when it HAS non-test callers (that's the point — DI/route registration hides real entry points), but still needs at least one callee (a flow of one step is filtered out today by `steps.length > 1` and stays that way). Missing/invalid JSON file → `[]` (never throws).

- [ ] **Step 1: Write the failing unit tests.** New `packages/server/test/entry-points.test.ts`:

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { loadConfiguredEntries, isExportedAt, entryEvidence } from "../src/graph/entry-points.js";

describe("entryEvidence", () => {
  it("scores configured entries 1.0 regardless of other flags", () => {
    expect(entryEvidence({ isRoot: false, isExported: false, isConfigured: true }))
      .toEqual({ reasons: ["configured"], confidence: 1.0 });
    expect(entryEvidence({ isRoot: true, isExported: true, isConfigured: true }))
      .toEqual({ reasons: ["graph-root", "exported", "configured"], confidence: 1.0 });
  });
  it("scores exported graph roots 0.7", () => {
    expect(entryEvidence({ isRoot: true, isExported: true, isConfigured: false }))
      .toEqual({ reasons: ["graph-root", "exported"], confidence: 0.7 });
  });
  it("scores bare graph roots 0.4", () => {
    expect(entryEvidence({ isRoot: true, isExported: false, isConfigured: false }))
      .toEqual({ reasons: ["graph-root"], confidence: 0.4 });
  });
});

describe("loadConfiguredEntries", () => {
  it("reads .crw-entry-points.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "crw-entries-"));
    writeFileSync(join(dir, ".crw-entry-points.json"),
      JSON.stringify({ entryPoints: [{ label: "main", file: "src/cli.ts" }] }));
    expect(loadConfiguredEntries(dir)).toEqual([{ label: "main", file: "src/cli.ts" }]);
  });
  it("returns [] when the file is missing or invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "crw-entries-"));
    expect(loadConfiguredEntries(dir)).toEqual([]);
    writeFileSync(join(dir, ".crw-entry-points.json"), "{not json");
    expect(loadConfiguredEntries(dir)).toEqual([]);
  });
});

describe("isExportedAt", () => {
  it("detects an export keyword at the definition line", () => {
    const dir = mkdtempSync(join(tmpdir(), "crw-exp-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "const x = 1;\nexport function foo() {}\nfunction bar() {}\n");
    expect(isExportedAt(dir, "src/a.ts", 2)).toBe(true);
    expect(isExportedAt(dir, "src/a.ts", 3)).toBe(false);
  });
  it("returns false for unreadable files", () => {
    expect(isExportedAt("/nonexistent", "nope.ts", 1)).toBe(false);
  });
});
```

In `packages/server/test/e2e.test.ts` (real-SCIP fixture: `handler.ts` exports `handler` which calls `helper`): extend the flows assertion — the flow headed by `handler` must have `entryReasons` equal to `["graph-root", "exported"]` and `entryConfidence` `0.7` (adapt only if the fixture's handler is genuinely not export-prefixed — read the fixture builder first).

In `packages/web/test/PlanView.test.tsx` (follow its existing mock pattern): a flow unit whose mocked flow has `entryConfidence: 0.7, entryReasons: ["graph-root","exported"]` renders a chip:

```tsx
it("shows entry confidence on flow units", () => {
  render(<PlanView ... />);
  const chip = screen.getByTestId(`entry-conf-${flowUnit.id}`);
  expect(chip.textContent).toContain("70%");
  expect(chip).toHaveAttribute("title", expect.stringContaining("exported"));
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @crw/server test` / `pnpm --filter @crw/web test`. Expected: module-not-found / missing chip.

- [ ] **Step 3: Implement the detector module.** Create `packages/server/src/graph/entry-points.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type EntryReason = "graph-root" | "exported" | "configured";

export interface EntryEvidence {
  reasons: EntryReason[];
  confidence: number;
}

export interface ConfiguredEntry {
  label: string;
  file?: string;
}

/** Optional explicit entry-point config at the repo root. Malformed or missing → []. */
export function loadConfiguredEntries(root: string): ConfiguredEntry[] {
  try {
    const raw = JSON.parse(readFileSync(join(root, ".crw-entry-points.json"), "utf8")) as {
      entryPoints?: unknown;
    };
    if (!Array.isArray(raw.entryPoints)) return [];
    return raw.entryPoints.filter(
      (e): e is ConfiguredEntry =>
        !!e && typeof (e as ConfiguredEntry).label === "string" &&
        ((e as ConfiguredEntry).file === undefined || typeof (e as ConfiguredEntry).file === "string")
    );
  } catch {
    return [];
  }
}

/** Whether the definition line begins with the `export` keyword. */
export function isExportedAt(
  root: string,
  file: string,
  startLine: number,
  cache?: Map<string, string[]>
): boolean {
  try {
    let lines = cache?.get(file);
    if (!lines) {
      lines = readFileSync(join(root, file), "utf8").split("\n");
      cache?.set(file, lines);
    }
    return (lines[startLine - 1] ?? "").trimStart().startsWith("export");
  } catch {
    return false;
  }
}

/**
 * Deterministic confidence: explicit configuration is trusted outright; an
 * exported graph root is probably a real external entry; a bare graph root
 * may just be a utility the index sees no callers for.
 */
export function entryEvidence(flags: {
  isRoot: boolean;
  isExported: boolean;
  isConfigured: boolean;
}): EntryEvidence {
  const reasons: EntryReason[] = [];
  if (flags.isRoot) reasons.push("graph-root");
  if (flags.isExported) reasons.push("exported");
  if (flags.isConfigured) reasons.push("configured");
  const confidence = flags.isConfigured ? 1.0 : flags.isRoot && flags.isExported ? 0.7 : 0.4;
  return { reasons, confidence };
}
```

- [ ] **Step 4: Thread evidence through flows.**

`packages/server/src/graph/provider.ts` — `Flow` gains:

```ts
  /** Why the entry heads this flow (graph-root / exported / configured). */
  entryReasons?: string[];
  /** 0–1; 1.0 = explicitly configured, 0.4 = bare graph root. */
  entryConfidence?: number;
```

`packages/server/src/graph/flow-tree.ts` — `makeFlow` becomes:

```ts
import type { EntryEvidence } from "./entry-points.js";

export function makeFlow(id: number, name: string, steps: FlowStep[], evidence?: EntryEvidence): Flow {
  return {
    id,
    name,
    criticality: flowCriticality(steps),
    depth: steps.reduce((m, s) => Math.max(m, s.depth), 0),
    steps,
    entryReasons: evidence?.reasons ?? ["graph-root"],
    entryConfidence: evidence?.confidence ?? 0.4,
  };
}
```

(check other `makeFlow` callers with `grep -rn "makeFlow(" packages/server/src` — the CRG path in `flows.ts` keeps working via the default.)

`packages/server/src/graph/scip.ts` `getFlows` (~lines 166-188) — replace the entry computation:

```ts
  async getFlows(changedStableIds?: Set<string>): Promise<Flow[]> {
    const g = await this.buildGraph();
    const relevant = changedStableIds ? reachesChanged(changedStableIds, g.callAdj) : undefined;
    const resolve = (sym: string) => {
      const n = g.nodes.get(sym);
      return n ? { label: n.label, file: n.file, startLine: n.startLine, endLine: n.endLine, isTest: n.isTest } : undefined;
    };
    // Graph roots: non-test nodes that head a call tree (have callees, no
    // NON-TEST callers) — test callers are TESTED_BY, not mid-flow evidence.
    const rootSyms = new Set(
      [...g.nodes.entries()]
        .filter(
          ([sym, n]) =>
            !n.isTest &&
            (g.callAdj.get(sym)?.length ?? 0) > 0 &&
            (g.callRev.get(sym) ?? []).filter((c) => !g.nodes.get(c)?.isTest).length === 0
        )
        .map(([sym]) => sym)
    );
    // Configured entries head flows even with callers (DI/route registration
    // hides real entry points from the call graph), but still need callees.
    const configured = loadConfiguredEntries(this.repoRoot);
    const configuredSyms = new Set(
      [...g.nodes.entries()]
        .filter(([, n]) =>
          configured.some((c) => c.label === n.label && (!c.file || n.file === c.file || n.file.endsWith(c.file)))
        )
        .filter(([sym]) => (g.callAdj.get(sym)?.length ?? 0) > 0)
        .map(([sym]) => sym)
    );
    const entrySyms = [...new Set([...rootSyms, ...configuredSyms])];
    const fileCache = new Map<string, string[]>();
    return entrySyms
      .map((sym, i) => {
        const n = g.nodes.get(sym)!;
        const evidence = entryEvidence({
          isRoot: rootSyms.has(sym),
          isExported: isExportedAt(this.repoRoot, n.file, n.startLine, fileCache),
          isConfigured: configuredSyms.has(sym),
        });
        return makeFlow(i + 1, n.label, buildFlowTree(sym, g.callAdj, resolve, relevant), evidence);
      })
      .filter((f) => f.steps.length > 1)
      .sort((a, b) => b.criticality - a.criticality);
  }
```

with imports `import { entryEvidence, isExportedAt, loadConfiguredEntries } from "./entry-points.js";`.

`packages/server/src/routes/flows.ts` — in the flow mapping object (~line 36) add:

```ts
        entryReasons: f.entryReasons ?? ["graph-root"],
        entryConfidence: f.entryConfidence ?? 0.4,
```

and change the sort (~line 41) to affected-first then confidence:

```ts
    flows.sort((a, b) => Number(b.affected) - Number(a.affected) || b.entryConfidence - a.entryConfidence);
```

- [ ] **Step 5: Web.** `packages/web/src/api/client.ts` `Flow` gains `entryReasons: string[]; entryConfidence: number;`. In `packages/web/src/components/PlanView.tsx` `UnitBlock`, after the `unit.auto` badge (~line 187) add:

```tsx
        {unit.kind === "flow" && flows.length > 0 && (
          <span
            className="unit__badge"
            data-testid={`entry-conf-${unit.id}`}
            title={`entry evidence: ${flows
              .map((f) => `${f.name}: ${(f.entryReasons ?? []).join("+")}`)
              .join("; ")}`}
          >
            ⚑ {Math.round(Math.max(...flows.map((f) => f.entryConfidence ?? 0.4)) * 100)}%
          </span>
        )}
```

- [ ] **Step 6: Run tests** — `pnpm test && pnpm typecheck` (e2e runs real scip-typescript, up to ~2 min). Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server packages/web
git commit -m "feat(server): entry-point provenance and confidence (graph-root/exported/configured)"
```

---

### Task 3: Server + web — atomic bulk review mutations and write transactions

**Files:**
- Create: `packages/server/src/repo/bulk.ts`
- Modify: `packages/server/src/validate.ts` (bulk schema), `packages/server/src/routes/nodes.ts` (new `PATCH /:id/nodes`), `packages/server/src/routes/sessions.ts` (wrap POST writes + PUT plan writes in transactions; `Map` for edge lookup)
- Modify: `packages/web/src/api/client.ts`, `packages/web/src/api/hooks.ts`, `packages/web/src/components/PlanView.tsx:123-134` (markRemaining)
- Test: `packages/server/test/repo.test.ts`, `packages/server/test/routes.test.ts`, `packages/web/test/PlanView.test.tsx`

**Interfaces:**
- Consumes: `getNode`, `updateNodeReviewStatus` (`repo/nodes.ts`), `nodeHasComments` (`repo/comments.ts`), `parseBody` + `ReviewStatus` enum values (Task-5-of-P1 `validate.ts`), `db.transaction` (better-sqlite3, synchronous).
- Produces:

```ts
// repo/bulk.ts — new module so it can import from both nodes.ts and comments.ts without a cycle
export class BulkNodeError extends Error { constructor(public missingNodeIds: string[]) { ... } }
export function bulkUpdateNodeReviewStatus(
  db: DB, sessionId: string, nodeIds: string[], status: ReviewStatus, reviewedInUnit?: number
): Node[];  // throws BulkNodeError (nothing written) if ANY id is missing/foreign
```

  Endpoint: `PATCH /api/sessions/:id/nodes` body `{ nodeIds: string[], reviewStatus, reviewedInUnit? }` → `{ nodes: Node[] }` (the updated set) | 404 `{ error, missingNodeIds }` | 400 validation. Web: `useBulkUpdateNodeStatus(sessionId)` hook, single invalidation of `nodes`, `node`, and `flows` queries.

- [ ] **Step 1: Write the failing tests.**

`packages/server/test/repo.test.ts`:

```ts
describe("bulkUpdateNodeReviewStatus", () => {
  it("updates all nodes in one call, normalizing commented nodes", () => {
    const db = createMemoryDatabase();
    const session = createSession(db, "HEAD", "main", "sha", "fp");
    const base = { sessionId: session.id, startLine: 1, endLine: 5, changeStatus: "changed" as const, reviewStatus: "unreviewed" as const, reviewedInUnit: null, isTest: false };
    const a = createNode(db, { ...base, stableId: "fn:a", label: "a", file: "a.ts" });
    const b = createNode(db, { ...base, stableId: "fn:b", label: "b", file: "b.ts" });
    createComment(db, session.id, b.id, "", "note", "");
    const updated = bulkUpdateNodeReviewStatus(db, session.id, [a.id, b.id], "reviewed-clean");
    expect(updated.map((n) => n.reviewStatus)).toEqual(["reviewed-clean", "reviewed-commented"]);
  });

  it("is atomic: one unknown id writes nothing", () => {
    const db = createMemoryDatabase();
    const session = createSession(db, "HEAD", "main", "sha", "fp");
    const base = { sessionId: session.id, startLine: 1, endLine: 5, changeStatus: "changed" as const, reviewStatus: "unreviewed" as const, reviewedInUnit: null, isTest: false };
    const a = createNode(db, { ...base, stableId: "fn:a", label: "a", file: "a.ts" });
    expect(() => bulkUpdateNodeReviewStatus(db, session.id, [a.id, "node_nope"], "reviewed-clean"))
      .toThrowError(BulkNodeError);
    expect(getNode(db, a.id)!.reviewStatus).toBe("unreviewed");
  });

  it("rejects a node from another session", () => {
    const db = createMemoryDatabase();
    const s1 = createSession(db, "HEAD", "main", "sha", "fp");
    const s2 = createSession(db, "HEAD", "main", "sha", "fp");
    const base = { startLine: 1, endLine: 5, changeStatus: "changed" as const, reviewStatus: "unreviewed" as const, reviewedInUnit: null, isTest: false };
    const foreign = createNode(db, { ...base, sessionId: s2.id, stableId: "fn:x", label: "x", file: "x.ts" });
    try {
      bulkUpdateNodeReviewStatus(db, s1.id, [foreign.id], "reviewed-clean");
      expect.unreachable();
    } catch (e) {
      expect((e as BulkNodeError).missingNodeIds).toEqual([foreign.id]);
    }
  });
});
```

`packages/server/test/routes.test.ts` (reuse the shared session helpers):

```ts
describe("bulk node status", () => {
  it("PATCH /nodes updates several nodes atomically", async () => {
    // create session, GET /nodes, take two node ids
    const res = await app.request(`/api/sessions/${sessionId}/nodes`, {
      method: "PATCH",
      body: JSON.stringify({ nodeIds: [id1, id2], reviewStatus: "reviewed-clean" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes).toHaveLength(2);
    expect(body.nodes.every((n: { reviewStatus: string }) => n.reviewStatus === "reviewed-clean")).toBe(true);
  });

  it("404s with the missing ids and writes nothing on a bad id", async () => {
    const res = await app.request(`/api/sessions/${sessionId}/nodes`, {
      method: "PATCH",
      body: JSON.stringify({ nodeIds: [id1, "node_nope"], reviewStatus: "reviewed-clean" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).missingNodeIds).toEqual(["node_nope"]);
    const after = await (await app.request(`/api/sessions/${sessionId}/nodes`)).json();
    expect(after.nodes.find((n: { id: string }) => n.id === id1).reviewStatus).toBe("unreviewed");
  });

  it("rejects an empty nodeIds array", async () => {
    const res = await app.request(`/api/sessions/${sessionId}/nodes`, {
      method: "PATCH",
      body: JSON.stringify({ nodeIds: [], reviewStatus: "reviewed-clean" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("validation failed");
  });
});
```

`packages/web/test/PlanView.test.tsx`: update the existing mark-remaining test (and the hooks mock) — mock `useBulkUpdateNodeStatus: () => ({ mutate: mockBulkMutate })`, stub `window.confirm` to true, and assert ONE call:

```tsx
expect(mockBulkMutate).toHaveBeenCalledTimes(1);
expect(mockBulkMutate).toHaveBeenCalledWith({ nodeIds: expect.arrayContaining([...]), reviewStatus: "reviewed-clean" });
```

- [ ] **Step 2: Run to verify failure** — repo/routes/web suites. Expected: FAIL (module/endpoint/hook missing).

- [ ] **Step 3: Implement the repo layer.** Create `packages/server/src/repo/bulk.ts`:

```ts
import type { DB } from "../db/connection.js";
import type { Node, ReviewStatus } from "../types.js";
import { getNode, updateNodeReviewStatus } from "./nodes.js";
import { nodeHasComments } from "./comments.js";

export class BulkNodeError extends Error {
  constructor(public missingNodeIds: string[]) {
    super(`nodes not found in session: ${missingNodeIds.join(", ")}`);
    this.name = "BulkNodeError";
  }
}

/**
 * All-or-nothing bulk review-status update. Verifies every node exists and
 * belongs to the session INSIDE the transaction, so a partial failure can
 * never leave a unit half-updated. Preserves the single-PATCH semantics:
 * reviewed-clean normalizes to reviewed-commented when comments exist.
 */
export function bulkUpdateNodeReviewStatus(
  db: DB,
  sessionId: string,
  nodeIds: string[],
  status: ReviewStatus,
  reviewedInUnit?: number
): Node[] {
  return db.transaction(() => {
    const missing = nodeIds.filter((id) => {
      const n = getNode(db, id);
      return !n || n.sessionId !== sessionId;
    });
    if (missing.length > 0) throw new BulkNodeError(missing);
    for (const id of nodeIds) {
      const effective =
        status === "reviewed-clean" && nodeHasComments(db, id) ? "reviewed-commented" : status;
      updateNodeReviewStatus(db, id, effective, reviewedInUnit);
    }
    return nodeIds.map((id) => getNode(db, id)!);
  })();
}
```

- [ ] **Step 4: Route + schema.** In `packages/server/src/validate.ts` add:

```ts
export const bulkNodeStatusSchema = z.object({
  nodeIds: z
    .array(z.string().min(1))
    .min(1, "nodeIds must be nonempty")
    .max(500, "too many nodeIds (max 500)"),
  reviewStatus: z.enum(["unreviewed", "reviewed-clean", "reviewed-commented", "reviewed-elsewhere"]),
  reviewedInUnit: z.number().int().nonnegative().optional(),
});
```

In `packages/server/src/routes/nodes.ts`, register BEFORE the single-node PATCH:

```ts
  router.patch("/:id/nodes", async (c) => {
    const parsed = await parseBody(c, bulkNodeStatusSchema);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;
    try {
      const nodes = bulkUpdateNodeReviewStatus(
        ctx.db, c.req.param("id"), [...new Set(body.nodeIds)], body.reviewStatus, body.reviewedInUnit
      );
      return c.json({ nodes });
    } catch (e) {
      if (e instanceof BulkNodeError) {
        return c.json({ error: "nodes not found in session", missingNodeIds: e.missingNodeIds }, 404);
      }
      throw e;
    }
  });
```

- [ ] **Step 5: Transactions on the existing multi-write routes.** In `packages/server/src/routes/sessions.ts` POST handler, wrap everything from `createSession` through edge insertion in one transaction and replace the O(n²) `dbNodes.find` with a `Map`:

```ts
    const session = ctx.db.transaction(() => {
      const session = createSession(ctx.db, body.branch, body.baseRef, headSha, repoFingerprint(ctx.repoRoot) ?? "");
      for (const gnode of keptNodes) {
        createNode(ctx.db, {
          sessionId: session.id, stableId: gnode.stableId,
          label: gnode.label, file: gnode.file, startLine: gnode.startLine, endLine: gnode.endLine,
          changeStatus: status.get(gnode.stableId)!, reviewStatus: "unreviewed", reviewedInUnit: null,
          isTest: gnode.isTest,
        });
      }
      for (const r of residuals) {
        createNode(ctx.db, {
          sessionId: session.id, stableId: r.stableId,
          label: r.label, file: r.file, startLine: r.startLine, endLine: r.endLine,
          changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null,
          isTest: r.isTest, residualRanges: r.ranges,
        });
      }
      const idByStable = new Map(getNodesBySession(ctx.db, session.id).map((n) => [n.stableId, n.id]));
      const insertEdge = ctx.db.prepare(
        "INSERT INTO edges (id, session_id, source_node_id, target_node_id, edge_type) VALUES (?, ?, ?, ?, ?)"
      );
      for (const gedge of subgraph.edges) {
        const source = idByStable.get(gedge.sourceStableId);
        const target = idByStable.get(gedge.targetStableId);
        if (source && target) insertEdge.run(randomId("edge"), session.id, source, target, gedge.edgeType);
      }
      return session;
    })();
    return c.json({ session, subgraph });
```

(the residual `createNode` call shown here already includes Task 1's `residualRanges: r.ranges` — keep them consistent). In the PUT `/:id/plan` handler, wrap the unit rewrite in a transaction:

```ts
    ctx.db.transaction(() => {
      for (const u of getUnitsBySession(ctx.db, sessionId)) deleteUnit(ctx.db, u.id);
      let pos = 0;
      for (const u of body.units) {
        const members = u.kind === "flow" ? flowEntries(u) : (u.orphanStableIds ?? []);
        createUnit(ctx.db, sessionId, pos++, u.label, u.rationale ?? "", u.kind, members, false);
      }
      if (unassigned.length > 0) {
        createUnit(ctx.db, sessionId, pos++, "Unassigned changes",
          "Changes not covered by any chosen unit.", "orphans", unassigned, true);
      }
      updateSessionStatus(ctx.db, sessionId, "walking");
    })();
```

- [ ] **Step 6: Web.** `packages/web/src/api/client.ts`:

```ts
  bulkUpdateNodeStatus: (sessionId: string, nodeIds: string[], reviewStatus: Node["reviewStatus"]) =>
    fetchJson<{ nodes: Node[] }>(`/sessions/${sessionId}/nodes`, {
      method: "PATCH", body: JSON.stringify({ nodeIds, reviewStatus }),
    }),
```

`packages/web/src/api/hooks.ts`:

```ts
export function useBulkUpdateNodeStatus(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeIds, reviewStatus }: { nodeIds: string[]; reviewStatus: Node["reviewStatus"] }) =>
      api.bulkUpdateNodeStatus(sessionId, nodeIds, reviewStatus),
    onSuccess: () => {
      // One request, one invalidation wave — including flows, whose steps
      // carry per-node reviewStatus.
      qc.invalidateQueries({ queryKey: ["nodes", sessionId] });
      qc.invalidateQueries({ queryKey: ["node", sessionId] });
      qc.invalidateQueries({ queryKey: ["flows", sessionId] });
    },
  });
}
```

(import the `Node` type from `./client.js`). `packages/web/src/components/PlanView.tsx` `UnitBlock` (~lines 123-134): add `const bulkStatus = useBulkUpdateNodeStatus(sessionId);` and replace the loop:

```tsx
  const markRemaining = () => {
    if (!window.confirm(`Mark ${remaining.length} node${remaining.length === 1 ? "" : "s"} reviewed?`)) return;
    bulkStatus.mutate({ nodeIds: remaining, reviewStatus: "reviewed-clean" });
  };
```

(keep `useUpdateNodeStatus` only if still used elsewhere in the file; remove the import if now unused).

- [ ] **Step 7: Run tests** — `pnpm test && pnpm typecheck`. Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/server packages/web
git commit -m "feat(server): atomic bulk review updates + transactional session/plan writes"
```

---

### Task 4: Docs — README config section + findings status

**Files:**
- Modify: `README.md` (new "Entry-point configuration" section after the existing export section)
- Modify: `docs/software-viability-usability-implementation-findings.md` (status line, Resolved list, Still-open list)

- [ ] **Step 1: README.** Add after the "Comment export" section:

````markdown
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
````

- [ ] **Step 2: Findings doc.** Update line 5's status note to append `; P2 items 1–3 implemented 2026-07-15`. Append to the **Resolved** list in the implementation-status section:

```markdown
- Entry-point inference too narrow / no confidence (Medium) — pluggable
  evidence (`graph-root` / `exported` / `.crw-entry-points.json` configured
  entries) with deterministic 0.4/0.7/1.0 confidence, exposed via the flows
  API and a plan-view chip; configured entries head flows despite callers.
- Residual bounding boxes (Medium) — residual pseudo-nodes store their exact
  ranges (schema v3 `nodes.residual_ranges`); the diff pane renders only
  those ranges, so hunks covered by function nodes are never shown twice.
- Bulk mutations non-atomic (Medium) — `PATCH /api/sessions/:id/nodes`
  applies a bulk status change in one SQLite transaction (all-or-nothing,
  comment normalization preserved); session creation and plan replacement
  are transactional; edge insertion uses a stableId map instead of repeated
  scans; the web "mark remaining" sends one request and one invalidation.
```

Update the **Still open** list to remove those three (leaving: SCIP edge semantics; error/loading/empty states; lint no-op; SSE cleanup; provider/session diagnostics if listed).

- [ ] **Step 3: Commit**

```bash
git add README.md docs/software-viability-usability-implementation-findings.md
git commit -m "docs: mark P2 items 1-3 implemented; document entry-point configuration"
```

---

### Task 5: End-to-end verification (controller-run)

**Files:** none (verification only; fix regressions if found)

- [ ] **Step 1:** `pnpm test && pnpm typecheck && pnpm build` — all green.
- [ ] **Step 2:** Launch the built app against this repo (`CRW_DB_PATH=<scratchpad>/crw-p2.db pnpm start`), create a session vs `main`, PUT a plan with flow units from `/flows`.
- [ ] **Step 3:** Verify via API + Playwright (browser works while the user's X session is active — do this early):
  1. `/flows` responses carry `entryReasons`/`entryConfidence`; the plan view shows the ⚑ confidence chip on flow units.
  2. A residual node (e.g. a docs/config file or module-scope residual) returns `residualRanges` and its diff pane shows only residual fragments with `⋯` gaps — no function hunks repeated from flow nodes.
  3. "✓✓ mark remaining" issues exactly ONE `PATCH /api/sessions/:id/nodes` (check the network or server log) and all chips flip in one refetch wave.
  4. Drop a `.crw-entry-points.json` naming a mid-graph function; recreate the session/flows and confirm a `configured`-reason flow at confidence 1.0 appears.
- [ ] **Step 4:** Kill the server, remove the scratch config file, run the final whole-branch review, then report.

---

## Self-review notes

- **Spec coverage:** finding "entry-point inference too narrow" → Task 2 (evidence + confidence + config detector; HTTP/CLI/event detectors from the findings list are represented by the explicit-config mechanism — automatic framework detection is deliberately deferred, noted in README wording); "residual bounding box" → Task 1 (exact ranges stored, diff renders only those ranges, one chip per file preserved); "bulk mutations non-atomic" → Task 3 (unit-scoped bulk endpoint via explicit ids, single transaction, updated node set returned, single invalidation) plus the findings' "Transactions and query efficiency" items (session creation txn, plan replacement txn, `Map` edge lookup).
- **Type consistency:** `LineRange` moves to `types.ts` and is re-exported from `diff.ts` so existing imports compile; `ResidualNode.ranges` → `createNode({ residualRanges })` → `Node.residualRanges` → web `Node.residualRanges` use one name; `EntryEvidence.reasons/confidence` flow into `Flow.entryReasons/entryConfidence` (optional on the provider type, required in the route response and web type); `bulkUpdateNodeReviewStatus` returns `Node[]` matching the route's `{ nodes }`.
- **Placeholder scan:** residuals/schema/e2e test steps reference existing fixture patterns by design (the implementer reads the test file first and adapts exact line numbers/labels); all production code is given in full.
- **Known break:** none — `residualRanges` is additive (null for old rows via migration), `Flow` fields are additive with route-level defaults, and the bulk endpoint is new. `packages/skill` consumes `/flows` but only reads fields it declares, so additive fields are safe.
