# Skill-driven, coverage-guaranteed review plan — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat flows panel with a Claude-ordered review *plan* of kind-tagged units (flow-units + orphan-units) where every changed node is guaranteed to appear in at least one unit, and remove the old graph view.

**Architecture:** Three layers. **Server** stores kind-tagged units with derived/many-to-many membership, reconciles coverage by sweeping uncovered changed nodes into an auto "Unassigned changes" unit, and exposes orphans + a compact per-node change summary. **Skill** (`orchestrate.ts` CLI) feeds Claude `flows + orphans + changes` (no diff bodies) and submits an ordered plan. **Web** renders the single unit-grouped Plan view.

**Tech Stack:** TypeScript ESM, Hono + better-sqlite3 (server), React 19 + @tanstack/react-query + zustand (web), Vitest everywhere. pnpm workspace.

## Global Constraints

- ESM throughout: relative imports end in `.js` (e.g. `import { x } from "./diff.js"`).
- Tests: Vitest with `globals: true` (`describe`/`it`/`expect` are global, no import needed). Run per package with `pnpm --filter <pkg> test` or a single file via `pnpm --filter <pkg> exec vitest run <path>`.
- Server is the only component that touches git/files (the "hub owns the git relationship"). The web UI never shells out.
- **No raw diff bodies in planning context** — `plan-context` emits the compact change summary only; diff bodies come from the bounded `diff` subcommand or the web UI.
- A "changed node" = a session node with `changeStatus === "changed"` (includes changed tests; excludes unchanged context nodes).
- Coverage invariant: every changed node appears in ≥1 unit; `covered + unassigned === changedTotal`.
- Commit message footer (every commit):
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Vda4vMpYdtb1bZeevrtjzy
  ```

---

### Task 1: Diff stats + signature helpers

Pure, additive helpers for the change summary. No existing behavior changes.

**Files:**
- Modify: `packages/server/src/diff.ts`
- Test: `packages/server/test/diff.test.ts`

**Interfaces:**
- Consumes: existing `parseHunks` (private), `repoRoot()`, `execFileSync`, `readFileSync` in `diff.ts`.
- Produces:
  - `fileUnifiedDiff(baseRef: string, file: string, root?: string): string | null`
  - `nodeChangeStats(rawDiff: string, startLine: number, endLine: number): { added: number; removed: number }`
  - `nodeSignature(file: string, startLine: number, root?: string): string`

- [ ] **Step 1: Write the failing test**

Append to `packages/server/test/diff.test.ts`:

```ts
import { nodeChangeStats } from "../src/diff.js";

describe("nodeChangeStats", () => {
  const raw = [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -10,2 +10,3 @@",
    " const a = 1;",   // context, new line 10
    "-const b = 2;",   // removed, attributed to new line 11
    "+const b = 3;",   // added, new line 11
    "+const c = 4;",   // added, new line 12
  ].join("\n");

  it("counts +/- lines within the node span", () => {
    expect(nodeChangeStats(raw, 10, 12)).toEqual({ added: 2, removed: 1 });
  });
  it("ignores changes outside the span", () => {
    expect(nodeChangeStats(raw, 10, 10)).toEqual({ added: 0, removed: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @crw/server exec vitest run test/diff.test.ts`
Expected: FAIL — `nodeChangeStats is not a function`.

- [ ] **Step 3: Implement the helpers**

In `packages/server/src/diff.ts`, add after `extractHunkDiff` (it reuses the existing private `parseHunks`):

```ts
/** The full unified diff (context 3) of a file vs baseRef, or null if none/errored. */
export function fileUnifiedDiff(baseRef: string, file: string, root: string = repoRoot()): string | null {
  try {
    const raw = execFileSync("git", ["diff", "--text", "--unified=3", baseRef, "--", file], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return raw.trim() ? raw : null;
  } catch {
    return null;
  }
}

/** Count +/- lines of a unified diff that fall within the new-file span [startLine, endLine]. */
export function nodeChangeStats(rawDiff: string, startLine: number, endLine: number): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of parseHunks(rawDiff)) {
    let newLine = h.newStart;
    for (const line of h.lines) {
      const marker = line[0];
      const inSpan = newLine >= startLine && newLine <= endLine;
      if (marker === "+") {
        if (inSpan) added++;
        newLine++;
      } else if (marker === " ") {
        newLine++;
      } else {
        // '-': no new-file line of its own; attribute to the upcoming new line.
        if (inSpan) removed++;
      }
    }
  }
  return { added, removed };
}

/** The declaration line of a node: first non-blank line at/after startLine. */
export function nodeSignature(file: string, startLine: number, root: string = repoRoot()): string {
  try {
    const lines = readFileSync(join(root, file), "utf8").split("\n");
    for (let i = startLine - 1; i < Math.min(lines.length, startLine + 4); i++) {
      const t = lines[i]?.trim();
      if (t) return t;
    }
  } catch {
    /* fall through */
  }
  return "";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @crw/server exec vitest run test/diff.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/diff.ts packages/server/test/diff.test.ts
git commit -m "feat(server): per-node diff stats + signature helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Vda4vMpYdtb1bZeevrtjzy"
```

---

### Task 2: Coverage computation (pure)

The function that, given the proposed units + flows + changed stableIds, returns covered and uncovered changed nodes. Pure and DB-free for easy testing; reused by the plan endpoint in Task 4.

**Files:**
- Create: `packages/server/src/coverage.ts`
- Test: `packages/server/test/coverage.test.ts`

**Interfaces:**
- Consumes: `Flow` from `./graph/provider.js` (`flow.steps[i].stableId`).
- Produces:
  - `interface PlanUnitInput { kind: "flow" | "orphans"; flowEntryStableId?: string; orphanStableIds?: string[]; label: string; rationale?: string; }`
  - `unitCoverage(unit: PlanUnitInput, flows: Flow[], changed: Set<string>): string[]`
  - `computeCoverage(units: PlanUnitInput[], flows: Flow[], changedStableIds: string[]): { covered: string[]; unassigned: string[] }`

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/coverage.test.ts`:

```ts
import { computeCoverage, type PlanUnitInput } from "../src/coverage.js";
import type { Flow } from "../src/graph/provider.js";

const step = (stableId: string, depth = 0) => ({
  stableId, label: stableId, file: "f.ts", startLine: 1, endLine: 2, isTest: false, depth,
});
const flows: Flow[] = [
  { id: 1, name: "handleOrder", criticality: 1, depth: 1, steps: [step("fn:handleOrder"), step("fn:validateOrder", 1)] },
];

describe("computeCoverage", () => {
  it("covers changed steps of a flow-unit by entry stableId", () => {
    const units: PlanUnitInput[] = [{ kind: "flow", flowEntryStableId: "fn:handleOrder", label: "Order" }];
    const r = computeCoverage(units, flows, ["fn:handleOrder", "fn:validateOrder", "fn:lonely"]);
    expect(r.covered.sort()).toEqual(["fn:handleOrder", "fn:validateOrder"]);
    expect(r.unassigned).toEqual(["fn:lonely"]);
  });

  it("covers orphan-unit members and reports the rest unassigned", () => {
    const units: PlanUnitInput[] = [{ kind: "orphans", orphanStableIds: ["fn:lonely"], label: "Other" }];
    const r = computeCoverage(units, flows, ["fn:handleOrder", "fn:lonely"]);
    expect(r.covered).toEqual(["fn:lonely"]);
    expect(r.unassigned).toEqual(["fn:handleOrder"]);
  });

  it("ignores a flow-unit whose entry matches no flow", () => {
    const units: PlanUnitInput[] = [{ kind: "flow", flowEntryStableId: "fn:ghost", label: "Ghost" }];
    const r = computeCoverage(units, flows, ["fn:handleOrder"]);
    expect(r.covered).toEqual([]);
    expect(r.unassigned).toEqual(["fn:handleOrder"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @crw/server exec vitest run test/coverage.test.ts`
Expected: FAIL — cannot find `../src/coverage.js`.

- [ ] **Step 3: Implement `coverage.ts`**

Create `packages/server/src/coverage.ts`:

```ts
import type { Flow } from "./graph/provider.js";

export interface PlanUnitInput {
  kind: "flow" | "orphans";
  flowEntryStableId?: string;
  orphanStableIds?: string[];
  label: string;
  rationale?: string;
}

/** The changed stableIds a single unit covers. A flow-unit covers the changed
 *  steps of the flow whose entry (depth-0 step) matches flowEntryStableId; an
 *  orphan-unit covers its listed members that are actually changed. */
export function unitCoverage(unit: PlanUnitInput, flows: Flow[], changed: Set<string>): string[] {
  if (unit.kind === "flow") {
    const flow = flows.find((f) => f.steps[0]?.stableId === unit.flowEntryStableId);
    if (!flow) return [];
    return flow.steps.map((s) => s.stableId).filter((id) => changed.has(id));
  }
  return (unit.orphanStableIds ?? []).filter((id) => changed.has(id));
}

export function computeCoverage(
  units: PlanUnitInput[],
  flows: Flow[],
  changedStableIds: string[]
): { covered: string[]; unassigned: string[] } {
  const changed = new Set(changedStableIds);
  const covered = new Set<string>();
  for (const u of units) for (const id of unitCoverage(u, flows, changed)) covered.add(id);
  const unassigned = changedStableIds.filter((id) => !covered.has(id));
  return { covered: [...covered], unassigned };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @crw/server exec vitest run test/coverage.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/coverage.ts packages/server/test/coverage.test.ts
git commit -m "feat(server): pure coverage computation over kind-tagged units

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Vda4vMpYdtb1bZeevrtjzy"
```

---

### Task 2.5: Provider exposes flow entry stableId on the route DTO

Prep so the flows route (Task 5) and coverage can key flows by entry. The provider `Flow` already carries `steps[0].stableId`; nothing to change in the provider — this task only verifies the data is there. **Fold this verification into Task 5** (no separate commit). Listed here so the dependency is explicit.

---

### Task 3: Schema, types, and repos for kind-tagged units

Migrate the `units` table to kind-tagged units with explicit member stableIds and an `auto` flag; drop the never-populated `nodes.unit_id`. Update the plan endpoint to the new request shape (coverage/reconciliation comes in Task 4) and keep all existing tests green.

**Files:**
- Modify: `packages/server/src/db/schema.ts`
- Modify: `packages/server/src/types.ts`
- Modify: `packages/server/src/repo/units.ts`
- Modify: `packages/server/src/repo/nodes.ts`
- Modify: `packages/server/src/routes/sessions.ts:91-104` (plan PUT) and `:63-70` (createNode call)
- Modify: `packages/server/src/routes/nodes.ts:13-14` (drop `unitId` query branch)
- Test: `packages/server/test/repo.test.ts`, `packages/server/test/routes.test.ts`, `packages/server/test/schema.test.ts`

**Interfaces:**
- Produces:
  - `type UnitKind = "flow" | "orphans"`
  - `Unit = { id, sessionId, position, label, rationale, kind: UnitKind, memberStableIds: string[], auto: boolean }`
  - `Node` — same as today **minus** `unitId`.
  - `createUnit(db, sessionId, position, label, rationale, kind: UnitKind, memberStableIds: string[], auto: boolean): Unit`
  - Plan request unit shape: `{ kind: "flow", flowEntryStableId, label, rationale? } | { kind: "orphans", orphanStableIds, label, rationale? }`
- Consumes: `randomId`, DB types.

- [ ] **Step 1: Write the failing test**

Replace the `PUT /api/sessions/:id/plan` test in `packages/server/test/routes.test.ts` (lines ~48-67) with the new shape, and add a repo test. New routes test block:

```ts
describe("PUT /api/sessions/:id/plan", () => {
  it("replaces the plan with kind-tagged units", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const res = await app.request(`/api/sessions/${session.id}/plan`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        units: [
          { kind: "flow", flowEntryStableId: "fn:handleOrder", label: "Order handling", rationale: "the order path" },
          { kind: "orphans", orphanStableIds: ["fn:validateOrder"], label: "Validation helpers" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.units.length).toBeGreaterThanOrEqual(2);
    expect(body.units[0].kind).toBe("flow");
    expect(body.units[0].memberStableIds).toEqual(["fn:handleOrder"]);
    expect(body.units[1].kind).toBe("orphans");
    expect(body.units[1].memberStableIds).toEqual(["fn:validateOrder"]);
  });
});
```

Append to `packages/server/test/repo.test.ts` (follow the file's existing import/setup style for `createUnit`/`getUnitsBySession`):

```ts
import { createUnit, getUnitsBySession } from "../src/repo/units.js";
import { createSession } from "../src/repo/sessions.js";

describe("units repo (kind-tagged)", () => {
  it("round-trips kind, memberStableIds, and auto", () => {
    const s = createSession(db, "feat", "main");
    createUnit(db, s.id, 0, "Order flow", "the order path", "flow", ["fn:handleOrder"], false);
    createUnit(db, s.id, 1, "Unassigned changes", "leftovers", "orphans", ["fn:x"], true);
    const units = getUnitsBySession(db, s.id);
    expect(units[0]).toMatchObject({ kind: "flow", memberStableIds: ["fn:handleOrder"], auto: false });
    expect(units[1]).toMatchObject({ kind: "orphans", memberStableIds: ["fn:x"], auto: true });
  });
});
```

(`repo.test.ts` already constructs a `db` in `beforeEach`; reuse it. If it doesn't import `createSession`, add the import shown.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @crw/server exec vitest run test/repo.test.ts test/routes.test.ts`
Expected: FAIL — `createUnit` arity/shape mismatch; plan response lacks `kind`.

- [ ] **Step 3: Migrate the schema**

In `packages/server/src/db/schema.ts`, replace the `units` table and the `nodes` table's `unit_id` line + its index:

```sql
CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  label TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'orphans',
  member_stable_ids TEXT NOT NULL DEFAULT '[]',
  auto INTEGER NOT NULL DEFAULT 0
);
```

In the `nodes` table remove the line `unit_id TEXT REFERENCES units(id) ON DELETE SET NULL,` and remove `CREATE INDEX IF NOT EXISTS idx_nodes_unit ON nodes(unit_id);`.

> **Migration note:** `CREATE TABLE IF NOT EXISTS` will not alter an existing dev DB. Delete the local server DB file so it is recreated (tests use in-memory DBs and are unaffected). Find it with `ls packages/server/*.db .code-review-graph/*.db 2>/dev/null` and remove the server's session DB (NOT the SCIP/CRG graph db). If unsure, check `packages/server/src/index.ts` / `db/connection.ts` for the path.

- [ ] **Step 4: Update types**

In `packages/server/src/types.ts`: add `export type UnitKind = "flow" | "orphans";`, replace the `Unit` interface, and remove `unitId` from `Node`:

```ts
export interface Unit {
  id: string;
  sessionId: string;
  position: number;
  label: string;
  rationale: string;
  kind: UnitKind;
  memberStableIds: string[];
  auto: boolean;
}

export interface Node {
  id: string;
  sessionId: string;
  stableId: string;
  label: string;
  file: string;
  startLine: number;
  endLine: number;
  changeStatus: ChangeStatus;
  reviewStatus: ReviewStatus;
  reviewedInUnit: number | null;
  isTest: boolean;
}
```

- [ ] **Step 5: Update the units repo**

Replace `packages/server/src/repo/units.ts`:

```ts
import type { DB } from "../db/connection.js";
import type { Unit, UnitKind } from "../types.js";
import { randomId } from "../util.js";

interface UnitRow {
  id: string; session_id: string; position: number; label: string;
  rationale: string; kind: UnitKind; member_stable_ids: string; auto: number;
}

function rowToUnit(row: UnitRow): Unit {
  return {
    id: row.id, sessionId: row.session_id, position: row.position,
    label: row.label, rationale: row.rationale, kind: row.kind,
    memberStableIds: JSON.parse(row.member_stable_ids), auto: row.auto === 1,
  };
}

export function createUnit(
  db: DB, sessionId: string, position: number, label: string,
  rationale: string, kind: UnitKind, memberStableIds: string[], auto: boolean
): Unit {
  const id = randomId("unit");
  db.prepare(
    "INSERT INTO units (id, session_id, position, label, rationale, kind, member_stable_ids, auto) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, sessionId, position, label, rationale, kind, JSON.stringify(memberStableIds), auto ? 1 : 0);
  return { id, sessionId, position, label, rationale, kind, memberStableIds, auto };
}

export function getUnitsBySession(db: DB, sessionId: string): Unit[] {
  const rows = db.prepare("SELECT * FROM units WHERE session_id = ? ORDER BY position").all(sessionId) as UnitRow[];
  return rows.map(rowToUnit);
}

export function deleteUnit(db: DB, id: string): void {
  db.prepare("DELETE FROM units WHERE id = ?").run(id);
}
```

(Drop the now-unused `updateUnit`; if anything imports it, the compiler will flag it — remove those references.)

- [ ] **Step 6: Update the nodes repo**

In `packages/server/src/repo/nodes.ts`: remove `unit_id` from `NodeRow`, from `rowToNode` (drop `unitId: row.unit_id`), from the `createNode` INSERT column list + values + the `node.unitId` argument, and delete `getNodesByUnit` entirely. Resulting `createNode` INSERT:

```ts
db.prepare(
  `INSERT INTO nodes (id, session_id, stable_id, label, file, start_line, end_line, change_status, review_status, reviewed_in_unit, is_test)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).run(id, node.sessionId, node.stableId, node.label, node.file,
  node.startLine, node.endLine, node.changeStatus, node.reviewStatus, node.reviewedInUnit, node.isTest ? 1 : 0);
```

- [ ] **Step 7: Update the routes**

`packages/server/src/routes/nodes.ts` — replace the list handler body lines that branch on `unitId`:

```ts
router.get("/:id/nodes", (c) => {
  const sessionId = c.req.param("id");
  const nodes = getNodesBySession(ctx.db, sessionId);
  const edges = ctx.db
    .prepare("SELECT source_node_id, target_node_id, edge_type FROM edges WHERE session_id = ?")
    .all(sessionId) as { source_node_id: string; target_node_id: string; edge_type: string }[];
  return c.json({
    nodes,
    edges: edges.map((e) => ({ sourceNodeId: e.source_node_id, targetNodeId: e.target_node_id, edgeType: e.edge_type })),
  });
});
```

Remove `getNodesByUnit` from that file's import.

`packages/server/src/routes/sessions.ts` — in the POST handler, drop `unitId: null` from the `createNode({...})` call. Replace the plan PUT handler body (coverage added in Task 4; for now store as given):

```ts
router.put("/:id/plan", async (c) => {
  const sessionId = c.req.param("id");
  const session = getSession(ctx.db, sessionId);
  if (!session) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ units: PlanUnitInput[] }>();
  for (const u of getUnitsBySession(ctx.db, sessionId)) deleteUnit(ctx.db, u.id);
  let pos = 0;
  for (const u of body.units) {
    const members = u.kind === "flow" ? [u.flowEntryStableId ?? ""] : (u.orphanStableIds ?? []);
    createUnit(ctx.db, sessionId, pos++, u.label, u.rationale ?? "", u.kind, members, false);
  }
  updateSessionStatus(ctx.db, sessionId, "walking");
  return c.json({ units: getUnitsBySession(ctx.db, sessionId) });
});
```

Add the import `import { computeCoverage, type PlanUnitInput } from "../coverage.js";` (the `computeCoverage` use lands in Task 4; importing the type now is fine). Ensure `createUnit` is imported.

- [ ] **Step 8: Run the full server suite**

Run: `pnpm --filter @crw/server test`
Expected: PASS. If `schema.test.ts` asserts specific columns, update it to the new `units` columns and the removed `unit_id`.

- [ ] **Step 9: Commit**

```bash
git add packages/server/src packages/server/test
git commit -m "feat(server): kind-tagged units, drop nodes.unit_id

Units carry kind + member_stable_ids + auto; plan PUT accepts the
kind-tagged request shape. Coverage reconciliation follows.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Vda4vMpYdtb1bZeevrtjzy"
```

---

### Task 4: Coverage reconciliation + reporting

Make the plan endpoint guarantee totality (sweep uncovered changed nodes into an auto "Unassigned changes" unit) and return `coverage`; add `coverage` to GET session (computed cheaply from the stored auto unit, no flow rebuild).

**Files:**
- Modify: `packages/server/src/routes/sessions.ts` (plan PUT + GET)
- Test: `packages/server/test/routes.test.ts`

**Interfaces:**
- Consumes: `computeCoverage` (Task 2), `ctx.graphProvider.getFlows()`, `getNodesBySession`, `getUnitsBySession`, `createUnit`.
- Produces: PUT `/plan` → `{ units: Unit[], coverage: Coverage }`; GET `/:id` → `{ session, units, coverage }` where `Coverage = { changedTotal: number; covered: number; unassigned: number }`.

> **Test provider note:** `StubGraphProvider.getFlows()` returns `[]`, so in tests every changed node is an orphan. Use that: a flow-unit referencing a stub entry covers nothing, so its changed nodes land in "Unassigned changes". Assert on that deterministically.

- [ ] **Step 1: Write the failing test**

Add to `packages/server/test/routes.test.ts`:

```ts
describe("coverage reconciliation", () => {
  it("sweeps uncovered changed nodes into an auto Unassigned unit and reports coverage", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    // Stub flows = [], so an orphan-unit covering one changed node leaves the rest unassigned.
    const res = await app.request(`/api/sessions/${session.id}/plan`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ units: [{ kind: "orphans", orphanStableIds: ["fn:handleOrder"], label: "Orders" }] }),
    });
    const body = await res.json();
    expect(body.coverage.changedTotal).toBe(2); // fn:handleOrder + fn:validateOrder are "changed" in the stub
    expect(body.coverage.covered).toBe(1);
    expect(body.coverage.unassigned).toBe(1);
    const auto = body.units.find((u: any) => u.auto);
    expect(auto.label).toBe("Unassigned changes");
    expect(auto.memberStableIds).toEqual(["fn:validateOrder"]);

    const sres = await app.request(`/api/sessions/${session.id}`);
    expect((await sres.json()).coverage).toEqual({ changedTotal: 2, covered: 1, unassigned: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @crw/server exec vitest run test/routes.test.ts`
Expected: FAIL — `coverage` undefined; no auto unit.

- [ ] **Step 3: Implement reconciliation in plan PUT**

Replace the plan PUT body (from Task 3) so it computes coverage and appends the auto unit:

```ts
router.put("/:id/plan", async (c) => {
  const sessionId = c.req.param("id");
  const session = getSession(ctx.db, sessionId);
  if (!session) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ units: PlanUnitInput[] }>();

  const flows = await ctx.graphProvider.getFlows();
  const changedStableIds = getNodesBySession(ctx.db, sessionId)
    .filter((n) => n.changeStatus === "changed")
    .map((n) => n.stableId);
  const { unassigned } = computeCoverage(body.units, flows, changedStableIds);

  for (const u of getUnitsBySession(ctx.db, sessionId)) deleteUnit(ctx.db, u.id);
  let pos = 0;
  for (const u of body.units) {
    const members = u.kind === "flow" ? [u.flowEntryStableId ?? ""] : (u.orphanStableIds ?? []);
    createUnit(ctx.db, sessionId, pos++, u.label, u.rationale ?? "", u.kind, members, false);
  }
  if (unassigned.length > 0) {
    createUnit(ctx.db, sessionId, pos++, "Unassigned changes",
      "Changes not covered by any chosen unit.", "orphans", unassigned, true);
  }
  updateSessionStatus(ctx.db, sessionId, "walking");

  const coverage = {
    changedTotal: changedStableIds.length,
    covered: changedStableIds.length - unassigned.length,
    unassigned: unassigned.length,
  };
  return c.json({ units: getUnitsBySession(ctx.db, sessionId), coverage });
});
```

- [ ] **Step 4: Add coverage to GET session**

Replace the GET `/:id` handler:

```ts
router.get("/:id", (c) => {
  const session = getSession(ctx.db, c.req.param("id"));
  if (!session) return c.json({ error: "not found" }, 404);
  const units = getUnitsBySession(ctx.db, session.id);
  const changed = getNodesBySession(ctx.db, session.id).filter((n) => n.changeStatus === "changed");
  const autoMembers = new Set(units.filter((u) => u.auto).flatMap((u) => u.memberStableIds));
  const unassigned = changed.filter((n) => autoMembers.has(n.stableId)).length;
  return c.json({
    session,
    units,
    coverage: { changedTotal: changed.length, covered: changed.length - unassigned, unassigned },
  });
});
```

(`getNodesBySession` must be imported in `sessions.ts` — it already is.)

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @crw/server exec vitest run test/routes.test.ts`
Expected: PASS. The earlier `GET /api/sessions/:id` test asserting `units: []` still passes; if it asserts the exact response object, add `coverage: { changedTotal: 0, covered: 0, unassigned: 0 }`.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/routes/sessions.ts packages/server/test/routes.test.ts
git commit -m "feat(server): coverage reconciliation + reporting on plan/session

Uncovered changed nodes are swept into an auto 'Unassigned changes'
unit; PUT /plan and GET session report { changedTotal, covered, unassigned }.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Vda4vMpYdtb1bZeevrtjzy"
```

---

### Task 5: Flows route exposes `entryStableId` + `orphans`

The Plan view keys flow-units to flows by entry, and the skill needs the orphan set.

**Files:**
- Modify: `packages/server/src/routes/flows.ts`
- Test: `packages/server/test/routes.test.ts`

**Interfaces:**
- Produces: GET `/:id/flows` → `{ flows: (Flow & { entryStableId: string })[], orphans: Node[] }` where `orphans` are changed nodes whose stableId is in no flow step.

> **Stub note:** with `getFlows() === []`, `flows` is `[]` and `orphans` = all changed nodes.

- [ ] **Step 1: Write the failing test**

Add to `packages/server/test/routes.test.ts`:

```ts
describe("GET /api/sessions/:id/flows", () => {
  it("returns flows and the orphan set (changed nodes in no flow)", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const res = await app.request(`/api/sessions/${session.id}/flows`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.flows)).toBe(true);
    // stub has no flows → both changed nodes are orphans
    expect(body.orphans.map((n: any) => n.stableId).sort()).toEqual(["fn:handleOrder", "fn:validateOrder"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @crw/server exec vitest run test/routes.test.ts`
Expected: FAIL — `body.orphans` undefined.

- [ ] **Step 3: Implement**

In `packages/server/src/routes/flows.ts`, within the handler, after building `flows`, add `entryStableId` per flow and compute orphans. Replace the return:

```ts
const allFlows = await ctx.graphProvider.getFlows();
const flows = allFlows.map((f) => {
  let affected = false;
  const steps = f.steps.map((s) => {
    const node = byStable.get(s.stableId);
    if (node && node.changeStatus === "changed") affected = true;
    return {
      label: s.label, file: s.file, startLine: s.startLine, endLine: s.endLine,
      isTest: s.isTest, depth: s.depth,
      nodeId: node?.id ?? null,
      changeStatus: node?.changeStatus ?? null,
      reviewStatus: node?.reviewStatus ?? null,
    };
  });
  return { id: f.id, name: f.name, criticality: f.criticality, depth: f.depth, affected, entryStableId: f.steps[0]?.stableId ?? "", steps };
});
flows.sort((a, b) => Number(b.affected) - Number(a.affected));

const inAnyFlow = new Set(allFlows.flatMap((f) => f.steps.map((s) => s.stableId)));
const orphans = nodes.filter((n) => n.changeStatus === "changed" && !inAnyFlow.has(n.stableId));

return c.json({ flows, orphans });
```

(`nodes` is the existing `getNodesBySession` result at the top of the handler.)

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @crw/server exec vitest run test/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/flows.ts packages/server/test/routes.test.ts
git commit -m "feat(server): flows route exposes entryStableId + orphan set

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Vda4vMpYdtb1bZeevrtjzy"
```

---

### Task 6: Change-summary route

`GET /:id/changes` → compact per-changed-node summary (no diff bodies).

**Files:**
- Create: `packages/server/src/routes/changes.ts`
- Modify: `packages/server/src/app.ts` (wire the route)
- Test: `packages/server/test/routes.test.ts`

**Interfaces:**
- Consumes: `getSession`, `getNodesBySession`, `fileUnifiedDiff`, `nodeChangeStats`, `nodeSignature` (Task 1).
- Produces: GET `/:id/changes` → `{ changes: ChangeSummary[] }`,
  `ChangeSummary = { stableId, label, kind: "function" | "method" | "test", file, startLine, endLine, status: "added" | "modified", added, removed, signature }`.

- [ ] **Step 1: Write the failing test**

Add to `packages/server/test/routes.test.ts`:

```ts
describe("GET /api/sessions/:id/changes", () => {
  it("returns one compact summary per changed node, no diff bodies", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const res = await app.request(`/api/sessions/${session.id}/changes`);
    expect(res.status).toBe(200);
    const { changes } = await res.json();
    expect(changes.map((c: any) => c.stableId).sort()).toEqual(["fn:handleOrder", "fn:validateOrder"]);
    for (const ch of changes) {
      expect(ch).toHaveProperty("added");
      expect(ch).toHaveProperty("removed");
      expect(ch).toHaveProperty("signature");
      expect(ch.kind).toBe("function");
      expect(ch).not.toHaveProperty("oldText");
      expect(ch).not.toHaveProperty("newText");
    }
  });
});
```

(The stub nodes point at `src/orders.ts` lines that don't exist on disk in the test repo; `fileUnifiedDiff` returns null → `added/removed` are 0 and `signature` is "". The test asserts shape, not magnitudes, so it is deterministic.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @crw/server exec vitest run test/routes.test.ts`
Expected: FAIL — 404 (route not mounted).

- [ ] **Step 3: Implement the route**

Create `packages/server/src/routes/changes.ts`:

```ts
import { Hono } from "hono";
import type { AppContext } from "../app.js";
import { getSession } from "../repo/sessions.js";
import { getNodesBySession } from "../repo/nodes.js";
import { fileUnifiedDiff, nodeChangeStats, nodeSignature } from "../diff.js";

/** Compact, software-computed change summary per changed node — no diff bodies.
 *  Bounded by node count, not diff size. */
export function createChangesRoute(ctx: AppContext) {
  const router = new Hono();

  router.get("/:id/changes", (c) => {
    const sessionId = c.req.param("id");
    const session = getSession(ctx.db, sessionId);
    if (!session) return c.json({ error: "not found" }, 404);

    const changed = getNodesBySession(ctx.db, sessionId).filter((n) => n.changeStatus === "changed");
    const rawByFile = new Map<string, string | null>();
    const rawFor = (file: string) => {
      if (!rawByFile.has(file)) rawByFile.set(file, fileUnifiedDiff(session.baseRef, file));
      return rawByFile.get(file) ?? null;
    };

    const changes = changed.map((n) => {
      const raw = rawFor(n.file);
      const { added, removed } = raw ? nodeChangeStats(raw, n.startLine, n.endLine) : { added: 0, removed: 0 };
      const span = n.endLine - n.startLine + 1;
      const status = removed === 0 && added >= span ? "added" : "modified";
      const kind = n.isTest ? "test" : n.stableId.includes("#") ? "method" : "function";
      return {
        stableId: n.stableId, label: n.label, kind,
        file: n.file, startLine: n.startLine, endLine: n.endLine,
        status, added, removed, signature: nodeSignature(n.file, n.startLine),
      };
    });
    return c.json({ changes });
  });

  return router;
}
```

In `packages/server/src/app.ts` add the import and mount it:

```ts
import { createChangesRoute } from "./routes/changes.js";
// ...
app.route("/api/sessions", createChangesRoute(ctx));
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @crw/server exec vitest run test/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/changes.ts packages/server/src/app.ts packages/server/test/routes.test.ts
git commit -m "feat(server): compact change-summary route (no diff bodies)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Vda4vMpYdtb1bZeevrtjzy"
```

---

### Task 7: Skill orchestrator — kind-tagged units, default partition, CLI subcommands

Update `orchestrate.ts` to the new unit shape, add a deterministic default partition, and add `plan-context` / `diff` / `submit-plan` subcommands.

**Files:**
- Modify: `packages/skill/src/orchestrate.ts`
- Test: `packages/skill/test/orchestrate.test.ts`

**Interfaces:**
- Produces:
  - `type UnitInput = { kind: "flow"; flowEntryStableId: string; label: string; rationale?: string } | { kind: "orphans"; orphanStableIds: string[]; label: string; rationale?: string }`
  - `interface FlowDTO { id: number; name: string; affected: boolean; entryStableId: string; steps: unknown[] }`
  - `interface OrphanDTO { stableId: string; label: string; file: string }`
  - `getFlows(sessionId): Promise<{ flows: FlowDTO[]; orphans: OrphanDTO[] }>`
  - `getChanges(sessionId): Promise<{ changes: unknown[] }>`
  - `writePlan(sessionId, units: UnitInput[]): Promise<{ units: unknown[]; coverage: { changedTotal: number; covered: number; unassigned: number } }>`
  - `defaultPartition(flows: FlowDTO[], orphans: OrphanDTO[]): UnitInput[]`

- [ ] **Step 1: Write the failing test**

Replace the `writes a plan` test and add a `defaultPartition` test in `packages/skill/test/orchestrate.test.ts`:

```ts
import { defaultPartition } from "../src/orchestrate.js";

describe("defaultPartition", () => {
  it("makes one flow-unit per affected flow plus an orphan unit", () => {
    const flows = [
      { id: 1, name: "handleOrder", affected: true, entryStableId: "fn:handleOrder", steps: [] },
      { id: 2, name: "unused", affected: false, entryStableId: "fn:unused", steps: [] },
    ];
    const orphans = [{ stableId: "fn:helper", label: "helper", file: "h.ts" }];
    const units = defaultPartition(flows as any, orphans as any);
    expect(units).toEqual([
      { kind: "flow", flowEntryStableId: "fn:handleOrder", label: "handleOrder" },
      { kind: "orphans", orphanStableIds: ["fn:helper"], label: "Other changes" },
    ]);
  });
});

describe("writePlan", () => {
  it("PUTs kind-tagged units and returns coverage", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ units: [], coverage: { changedTotal: 1, covered: 1, unassigned: 0 } }));
    const r = await writePlan("s1", [{ kind: "flow", flowEntryStableId: "fn:a", label: "A" }]);
    expect(r.coverage.unassigned).toBe(0);
    expect(mockFetch).toHaveBeenCalledWith("http://localhost:3456/api/sessions/s1/plan", expect.objectContaining({ method: "PUT" }));
  });
});
```

Remove the old `orchestrates the full flow` test's reliance on the old `partitionFn(subgraph)` shape (update it or delete it; the default-partition path is the supported one).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @crw/skill exec vitest run`
Expected: FAIL — `defaultPartition` missing; `writePlan` return shape.

- [ ] **Step 3: Implement**

In `packages/skill/src/orchestrate.ts`, replace `UnitInput` and `writePlan`, and add the new helpers + subcommands:

```ts
export type UnitInput =
  | { kind: "flow"; flowEntryStableId: string; label: string; rationale?: string }
  | { kind: "orphans"; orphanStableIds: string[]; label: string; rationale?: string };

export interface FlowDTO { id: number; name: string; affected: boolean; entryStableId: string; steps: unknown[]; }
export interface OrphanDTO { stableId: string; label: string; file: string; }

export async function getFlows(sessionId: string): Promise<{ flows: FlowDTO[]; orphans: OrphanDTO[] }> {
  return fetchJson(`${SERVER_URL}/api/sessions/${sessionId}/flows`);
}
export async function getChanges(sessionId: string): Promise<{ changes: unknown[] }> {
  return fetchJson(`${SERVER_URL}/api/sessions/${sessionId}/changes`);
}
export async function getNodes(sessionId: string): Promise<{ nodes: { id: string; stableId: string }[] }> {
  return fetchJson(`${SERVER_URL}/api/sessions/${sessionId}/nodes`);
}
export async function getNodeDiff(sessionId: string, nodeId: string): Promise<Record<string, unknown>> {
  return fetchJson(`${SERVER_URL}/api/sessions/${sessionId}/nodes/${nodeId}`);
}

export async function writePlan(
  sessionId: string, units: UnitInput[]
): Promise<{ units: unknown[]; coverage: { changedTotal: number; covered: number; unassigned: number } }> {
  return fetchJson(`${SERVER_URL}/api/sessions/${sessionId}/plan`, { method: "PUT", body: JSON.stringify({ units }) });
}

/** Deterministic plan: one flow-unit per affected flow + one catch-all orphan unit. */
export function defaultPartition(flows: FlowDTO[], orphans: OrphanDTO[]): UnitInput[] {
  const flowUnits: UnitInput[] = flows
    .filter((f) => f.affected)
    .map((f) => ({ kind: "flow", flowEntryStableId: f.entryStableId, label: f.name }));
  const orphanUnit: UnitInput[] = orphans.length
    ? [{ kind: "orphans", orphanStableIds: orphans.map((o) => o.stableId), label: "Other changes" }]
    : [];
  return [...flowUnits, ...orphanUnit];
}
```

Replace the `main()` argument dispatch so the CLI supports subcommands:

```ts
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

  if (cmd === "plan-context") {
    const branch = opt("--branch") ?? "HEAD";
    const baseRef = opt("--base") ?? "main";
    const { session } = await createSession(branch, baseRef);
    const { flows, orphans } = await getFlows(session.id);
    const { changes } = await getChanges(session.id);
    console.log(JSON.stringify({ sessionId: session.id, flows, orphans, changes }, null, 2));
    return;
  }
  if (cmd === "diff") {
    const sessionId = opt("--session")!;
    const stableId = opt("--node")!;
    const { nodes } = await getNodes(sessionId);
    const node = nodes.find((n) => n.stableId === stableId);
    if (!node) { console.error(`no node ${stableId}`); process.exit(1); }
    console.log(JSON.stringify(await getNodeDiff(sessionId, node!.id), null, 2));
    return;
  }
  if (cmd === "submit-plan") {
    const sessionId = opt("--session")!;
    const planPath = opt("--plan")!;
    const { readFileSync } = await import("node:fs");
    const units = JSON.parse(readFileSync(planPath, "utf8")) as UnitInput[];
    const { coverage } = await writePlan(sessionId, units);
    console.log(JSON.stringify({ coverage }, null, 2));
    launchUI(sessionId);
    return;
  }

  // Default (no subcommand): create a session and write the deterministic plan.
  const branch = opt("--branch") ?? "HEAD";
  const baseRef = opt("--base") ?? "main";
  const { session } = await createSession(branch, baseRef);
  const { flows, orphans } = await getFlows(session.id);
  const { coverage } = await writePlan(session.id, defaultPartition(flows, orphans));
  console.log("Session:", session.id, "coverage:", coverage);
  launchUI(session.id);
}
```

Update or remove the old `orchestrate(branch, baseRef, partitionFn)` export and its test — the supported entry points are now the CLI subcommands + `defaultPartition`. If you keep `orchestrate`, change `partitionFn` to `(ctx: { flows: FlowDTO[]; orphans: OrphanDTO[] }) => UnitInput[]`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @crw/skill exec vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/skill/src/orchestrate.ts packages/skill/test/orchestrate.test.ts
git commit -m "feat(skill): plan-context/diff/submit-plan CLI + kind-tagged default partition

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Vda4vMpYdtb1bZeevrtjzy"
```

---

### Task 8: skill.md — "Building the review plan"

Documentation so Claude drives the new flow correctly.

**Files:**
- Modify: `packages/skill/skill.md`

- [ ] **Step 1: Replace the "Partitioning guidance" section**

Replace the `## Partitioning guidance` section at the end of `packages/skill/skill.md` with:

````markdown
## Building the review plan

The plan is an ordered list of **units**, each either a **flow** or an **orphan group**:

- **flow-unit** — `{ "kind": "flow", "flowEntryStableId": "<entry>", "label": "...", "rationale": "..." }`
- **orphan-unit** — `{ "kind": "orphans", "orphanStableIds": ["..."], "label": "...", "rationale": "..." }`

Steps:

1. Run `npx tsx packages/skill/src/orchestrate.ts plan-context --branch <b> --base <base>`.
   It prints `{ sessionId, flows, orphans, changes }`. `changes` is a compact per-node
   summary (kind, file, lines, +/- counts, signature) — **not** diff bodies.
2. Make one flow-unit per **affected** flow (`flows[].affected === true`), using `entryStableId`.
   Do not split or merge flows.
3. Group the `orphans` into orphan-units by shared purpose (e.g. "validation helpers",
   "test fixtures"), using each change's `kind`/`file`/`signature` from `changes`.
4. Give each unit a `label` and an optional short `rationale` describing **what the unit
   does** (its functionality/purpose) — not why you ordered it.
5. Order units for a sensible walk (foundational/helper changes first, then the flows that
   depend on them — your judgment).
6. Write the units array to a JSON file and run
   `npx tsx packages/skill/src/orchestrate.ts submit-plan --session <sessionId> --plan plan.json`.
   It prints `coverage`. If `coverage.unassigned > 0`, add orphan-units for the leftovers
   (they were swept into the auto "Unassigned changes" unit) and re-submit.

**Never run `git diff` for planning.** If you must read a node's code to decide grouping,
run `npx tsx packages/skill/src/orchestrate.ts diff --session <sessionId> --node <stableId>`
— it returns just that one node's diff.
````

Also update the `## How to orchestrate` section's command list to mention `plan-context` / `submit-plan` instead of the single-shot script.

- [ ] **Step 2: Commit**

```bash
git add packages/skill/skill.md
git commit -m "docs(skill): review-plan building guidance (no git diff in planning)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Vda4vMpYdtb1bZeevrtjzy"
```

---

### Task 9: Web API client + store updates

Update the web types/calls to the new shapes and drop `viewMode`. No UI behavior yet (PlanView lands in Task 11), so wire `SplitLayout` to render the existing `FlowsView` directly to keep the app compiling between tasks.

**Files:**
- Modify: `packages/web/src/api/client.ts`
- Modify: `packages/web/src/store/ui.ts`

**Interfaces:**
- Produces:
  - `Unit = { id, sessionId, position, label, rationale, kind: "flow" | "orphans", memberStableIds: string[], auto: boolean }`
  - `Node` — drop `unitId`.
  - `Flow` — add `entryStableId: string`.
  - `getSession(id)` → `{ session, units, coverage: Coverage }`; `Coverage = { changedTotal: number; covered: number; unassigned: number }`.
  - `getFlows(id)` → `{ flows: Flow[]; orphans: Node[] }`.
  - `updatePlan(id, units: UnitInput[])` with the kind-tagged `UnitInput` union.
  - `useUIStore` without `viewMode` / `setViewMode`.

- [ ] **Step 1: Edit `client.ts`**

- In `interface Unit`, replace `rationale: string; entryPointNodeIds: string[];` with:
  ```ts
  rationale: string;
  kind: "flow" | "orphans";
  memberStableIds: string[];
  auto: boolean;
  ```
- In `interface Node`, remove `unitId: string | null;`.
- In `interface Flow`, add `entryStableId: string;`.
- Add:
  ```ts
  export interface Coverage { changedTotal: number; covered: number; unassigned: number; }
  export type UnitInput =
    | { kind: "flow"; flowEntryStableId: string; label: string; rationale?: string }
    | { kind: "orphans"; orphanStableIds: string[]; label: string; rationale?: string };
  ```
- Change `getSession` return type to `{ session: ReviewSession; units: Unit[]; coverage: Coverage }`.
- Change `getFlows` return type to `{ flows: Flow[]; orphans: Node[] }`.
- Change `updatePlan` signature to:
  ```ts
  updatePlan: (id: string, units: UnitInput[]) =>
    fetchJson<{ units: Unit[]; coverage: Coverage }>(`/sessions/${id}/plan`, {
      method: "PUT", body: JSON.stringify({ units }),
    }),
  ```
- `getNodes` still accepts `unitId?` in its type; drop that param (the route no longer supports it): `getNodes: (id: string) => fetchJson<{ nodes: Node[]; edges: GraphEdgeDTO[] }>(\`/sessions/${id}/nodes\`)`.

- [ ] **Step 2: Edit `store/ui.ts`**

Remove `type ViewMode`, the `viewMode` / `setViewMode` fields from `UIState`, and their initializers. Update the `splitRatio` comment to "left (plan) : right (diff) ≈ 1:2". Update `useNodes` hook call sites if they passed `unitId` (none currently do besides the signature).

- [ ] **Step 3: Keep the app compiling**

In `packages/web/src/components/SplitLayout.tsx`, temporarily remove the `viewMode` read and the `GraphView` branch, rendering `FlowsView` directly:

```tsx
<div style={{ flex: splitRatio, overflow: "hidden", height: "100%" }}>
  <FlowsView sessionId={sessionId} currentNodeId={currentNodeId} onSelectNode={setCurrentNode} />
</div>
```

Remove the `GraphView` import and the `viewMode` line from `SplitLayout.tsx`. (Full graph-view deletion is Task 10.)

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @crw/web typecheck`
Expected: errors only where `App.tsx` still references `ViewToggle`/`viewMode` and `useNodes(…, unitId)` — those are fixed in Task 10/12. If `App.tsx` blocks the typecheck, proceed to Task 10 before re-running; otherwise it should pass.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api/client.ts packages/web/src/store/ui.ts packages/web/src/components/SplitLayout.tsx
git commit -m "feat(web): client types for kind-tagged units, coverage, orphans; drop viewMode

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Vda4vMpYdtb1bZeevrtjzy"
```

---

### Task 10: Remove the graph view

Delete the graph view and its dependencies; remove the toggle.

**Files:**
- Delete: `packages/web/src/components/GraphView.tsx`
- Delete: `packages/web/src/components/FrontierStrip.tsx`
- Modify: `packages/web/src/App.tsx` (remove `ViewToggle`, the `viewMode` field render)
- Modify: `packages/web/package.json` (remove `@dagrejs/dagre`, `@xyflow/react`)

- [ ] **Step 1: Confirm nothing else imports them**

Run: `grep -rn "GraphView\|FrontierStrip\|@xyflow\|@dagrejs" packages/web/src`
Expected: matches only inside the two files being deleted (and `App.tsx`'s `ViewToggle`). If anything else references them, fix it in this task.

- [ ] **Step 2: Delete the files**

```bash
git rm packages/web/src/components/GraphView.tsx packages/web/src/components/FrontierStrip.tsx
```

- [ ] **Step 3: Remove the toggle from `App.tsx`**

Delete the entire `ViewToggle` function and its `<ViewToggle />` usage in `StatusBar`. (The coverage chip replaces the `unit` field — done in Task 12; for now leave the `unit` field as-is.) Remove any now-unused imports (`useUIStore`'s `viewMode`).

- [ ] **Step 4: Drop the deps**

In `packages/web/package.json`, remove the `@dagrejs/dagre` and `@xyflow/react` lines from `dependencies`, then:

```bash
pnpm install
```

- [ ] **Step 5: Verify build**

Run: `pnpm --filter @crw/web typecheck && pnpm --filter @crw/web build`
Expected: PASS (no dangling imports).

- [ ] **Step 6: Commit**

```bash
git add -A packages/web
git commit -m "refactor(web): remove graph view, toggle, and its deps

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Vda4vMpYdtb1bZeevrtjzy"
```

---

### Task 11: Plan view (unit-grouped)

Replace `FlowsView` with `PlanView`: ordered units; flow-units render the call-tree track, orphan-units render node chips, the auto unit gets a warning treatment.

**Files:**
- Create: `packages/web/src/components/PlanView.tsx`
- Delete: `packages/web/src/components/FlowsView.tsx`
- Modify: `packages/web/src/components/SplitLayout.tsx` (render `PlanView`)
- Modify: `packages/web/src/styles.css` (add `.unit` / `.unit--auto` styles — reuse existing `.flow*`/`.step*` classes for the track)
- Test: `packages/web/test/PlanView.test.tsx`

**Interfaces:**
- Consumes: `useSession` (`units`), `useFlows` (`flows`, `orphans`), `useNodes` (`nodes`), client `Unit`/`Flow`/`Node`.
- Produces: `<PlanView sessionId currentNodeId onSelectNode />` (same prop contract `FlowsView` had).

- [ ] **Step 1: Write the failing test**

Create `packages/web/test/PlanView.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { PlanView } from "../src/components/PlanView.js";

vi.mock("../src/api/hooks.js", () => ({
  useSession: () => ({ data: { units: [
    { id: "u1", position: 0, kind: "flow", label: "Order handling", rationale: "the order path", memberStableIds: ["fn:handleOrder"], auto: false },
    { id: "u2", position: 1, kind: "orphans", label: "Validation helpers", rationale: "", memberStableIds: ["fn:validateOrder"], auto: false },
    { id: "u3", position: 2, kind: "orphans", label: "Unassigned changes", rationale: "", memberStableIds: ["fn:lonely"], auto: true },
  ], coverage: { changedTotal: 3, covered: 2, unassigned: 1 } } }),
  useFlows: () => ({ data: { flows: [
    { id: 1, name: "handleOrder", criticality: 1, depth: 1, affected: true, entryStableId: "fn:handleOrder",
      steps: [{ label: "handleOrder", file: "o.ts", startLine: 1, endLine: 2, isTest: false, depth: 0, nodeId: "n1", changeStatus: "changed", reviewStatus: "unreviewed" }] },
  ], orphans: [] } }),
  useNodes: () => ({ data: { nodes: [
    { id: "n2", stableId: "fn:validateOrder", label: "validateOrder", file: "o.ts", startLine: 3, endLine: 4, changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null, isTest: false },
    { id: "n3", stableId: "fn:lonely", label: "lonely", file: "x.ts", startLine: 1, endLine: 2, changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null, isTest: false },
  ] } }),
}));

describe("PlanView", () => {
  it("renders units in order with flow track, orphan chips, and an unassigned warning", () => {
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(headings).toEqual(["Order handling", "Validation helpers", "Unassigned changes"]);
    expect(screen.getByText("handleOrder")).toBeInTheDocument();   // flow track step
    expect(screen.getByText("validateOrder")).toBeInTheDocument(); // orphan chip
    expect(screen.getByText("Unassigned changes").closest(".unit")).toHaveClass("unit--auto");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @crw/web exec vitest run test/PlanView.test.tsx`
Expected: FAIL — cannot find `PlanView`.

- [ ] **Step 3: Implement `PlanView.tsx`**

Create `packages/web/src/components/PlanView.tsx` (the `FlowTrack`/`StepChip` are moved here from `FlowsView`):

```tsx
import { useFlows, useNodes, useSession } from "../api/hooks.js";
import type { Flow, FlowStep, Node, Unit } from "../api/client.js";

export function PlanView({
  sessionId, currentNodeId, onSelectNode,
}: {
  sessionId: string;
  currentNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  const { data: sessionData } = useSession(sessionId);
  const { data: flowsData } = useFlows(sessionId);
  const { data: nodesData } = useNodes(sessionId);

  const units = (sessionData?.units ?? []).slice().sort((a, b) => a.position - b.position);
  const flowByEntry = new Map((flowsData?.flows ?? []).map((f) => [f.entryStableId, f]));
  const nodeByStable = new Map((nodesData?.nodes ?? []).map((n) => [n.stableId, n]));

  if (units.length === 0) {
    return (
      <div style={empty}>
        <div style={{ maxWidth: 320, textAlign: "center" }}>
          <div style={{ fontSize: 26, marginBottom: 10, opacity: 0.5 }}>⌖</div>
          <h2 style={{ fontSize: 16, marginBottom: 6 }}>No review plan yet</h2>
          <p style={{ color: "var(--dim)", fontSize: 13, lineHeight: 1.6, margin: 0 }}>
            Run the walkthrough skill to build a plan, or check that the session has changes.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={wrap}>
      <div style={head}>
        <span style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 15 }}>Plan</span>
        <span style={{ color: "var(--dim)", fontSize: 13 }}>{units.length} units</span>
      </div>
      <div style={{ overflow: "auto", flex: 1, padding: "4px 16px 20px" }}>
        {units.map((u) => (
          <UnitBlock
            key={u.id}
            unit={u}
            flow={u.kind === "flow" ? flowByEntry.get(u.memberStableIds[0]) : undefined}
            nodeByStable={nodeByStable}
            currentNodeId={currentNodeId}
            onSelectNode={onSelectNode}
          />
        ))}
      </div>
    </div>
  );
}

function UnitBlock({
  unit, flow, nodeByStable, currentNodeId, onSelectNode,
}: {
  unit: Unit;
  flow?: Flow;
  nodeByStable: Map<string, Node>;
  currentNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  const memberNodes = unit.memberStableIds.map((s) => nodeByStable.get(s)).filter((n): n is Node => !!n);
  const reviewed = memberNodes.filter((n) => n.reviewStatus !== "unreviewed").length;

  return (
    <div className={`unit${unit.auto ? " unit--auto" : ""}`}>
      <div className="unit__bar">
        <h3 className="unit__name">{unit.label}</h3>
        {unit.auto && <span className="unit__badge">unassigned</span>}
        {memberNodes.length > 0 && (
          <span className="unit__progress">{reviewed}/{memberNodes.length}</span>
        )}
      </div>
      {unit.rationale && <p className="unit__rationale">{unit.rationale}</p>}

      {unit.kind === "flow" && flow ? (
        <FlowTrack flow={flow} currentNodeId={currentNodeId} onSelectNode={onSelectNode} />
      ) : (
        <div className="unit__chips">
          {memberNodes.map((n) => (
            <StepChip
              key={n.id}
              step={{
                label: n.label, file: n.file, startLine: n.startLine, endLine: n.endLine,
                isTest: n.isTest, depth: 0, nodeId: n.id, changeStatus: n.changeStatus, reviewStatus: n.reviewStatus,
              }}
              current={n.id === currentNodeId}
              onSelect={onSelectNode}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FlowTrack({
  flow, currentNodeId, onSelectNode,
}: {
  flow: Flow;
  currentNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  return (
    <div className="flow__tree">
      {flow.steps.map((s, i) => (
        <div key={i} className="flow__row" style={{ paddingLeft: s.depth * 22 }}>
          {s.depth > 0 && <span className="flow__branch">└</span>}
          <StepChip step={s} current={!!s.nodeId && s.nodeId === currentNodeId} onSelect={onSelectNode} />
        </div>
      ))}
    </div>
  );
}

function StepChip({
  step, current, onSelect,
}: {
  step: FlowStep;
  current: boolean;
  onSelect: (nodeId: string) => void;
}) {
  const cls = [
    "step",
    step.changeStatus === "changed" ? "step--changed" : "",
    step.changeStatus === null ? "step--ext" : "",
    step.isTest ? "step--test" : "",
    step.reviewStatus && step.reviewStatus !== "unreviewed" ? "step--reviewed" : "",
    current ? "step--current" : "",
  ].filter(Boolean).join(" ");
  return (
    <button
      className={cls}
      disabled={!step.nodeId}
      onClick={() => step.nodeId && onSelect(step.nodeId)}
      title={`${step.file}:${step.startLine}`}
    >
      {step.label}
    </button>
  );
}

const wrap: React.CSSProperties = {
  flex: 1, height: "100%", display: "flex", flexDirection: "column",
  background: "var(--panel)", minHeight: 0,
};
const head: React.CSSProperties = {
  display: "flex", alignItems: "baseline", justifyContent: "space-between",
  padding: "14px 16px 10px", borderBottom: "1px solid var(--line)",
};
const empty: React.CSSProperties = {
  flex: 1, height: "100%", display: "grid", placeItems: "center", background: "var(--panel)",
};
```

> The empty-state glyph (`⌖`) is cosmetic — swap for any sensible icon.

- [ ] **Step 4: Add styles**

Append to `packages/web/src/styles.css`:

```css
.unit { padding: 10px 0 14px; border-bottom: 1px solid var(--line); }
.unit__bar { display: flex; align-items: baseline; gap: 8px; }
.unit__name { font-size: 14px; font-weight: 700; margin: 0; }
.unit__badge { font-size: 11px; color: var(--warn, #d98a2b); border: 1px solid var(--warn, #d98a2b); border-radius: 4px; padding: 0 5px; }
.unit__progress { margin-left: auto; font-size: 12px; color: var(--dim); font-variant-numeric: tabular-nums; }
.unit__rationale { margin: 2px 0 8px; font-size: 12px; color: var(--dim); line-height: 1.5; }
.unit__chips { display: flex; flex-wrap: wrap; gap: 6px; }
.unit--auto { background: color-mix(in srgb, var(--warn, #d98a2b) 8%, transparent); border-radius: 6px; padding-left: 8px; padding-right: 8px; }
```

(If `--warn` isn't defined in `:root`, add `--warn: #d98a2b;` there.)

- [ ] **Step 5: Wire `SplitLayout` and delete `FlowsView`**

In `SplitLayout.tsx`, replace the `FlowsView` import/usage with `PlanView`, and rewrite the `EmptyState` copy that mentions "The graph is the change…" to describe the plan walk (e.g. "Pick a unit's node to read its diff and leave a comment."). Then:

```bash
git rm packages/web/src/components/FlowsView.tsx
```

- [ ] **Step 6: Run tests + build**

Run: `pnpm --filter @crw/web exec vitest run test/PlanView.test.tsx && pnpm --filter @crw/web typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A packages/web
git commit -m "feat(web): unit-grouped Plan view replaces flows panel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Vda4vMpYdtb1bZeevrtjzy"
```

---

### Task 12: Coverage chip in the status bar

Replace the `unit` field in `StatusBar` with a coverage chip that flags unassigned changes.

**Files:**
- Modify: `packages/web/src/App.tsx`
- Test: `packages/web/test/StatusBar.test.tsx`

**Interfaces:**
- Consumes: `useSession(sessionId).data.coverage`, `data.units`.

- [ ] **Step 1: Write the failing test**

Create `packages/web/test/StatusBar.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { vi } from "vitest";

vi.mock("../src/api/hooks.js", () => ({
  useSession: () => ({ data: { session: { branch: "feat" }, units: [{}, {}], coverage: { changedTotal: 5, covered: 4, unassigned: 1 } } }),
  useNodes: () => ({ data: { nodes: [] } }),
}));

import { StatusBar } from "../src/App.js";

describe("StatusBar coverage chip", () => {
  it("shows units and a warning when changes are unassigned", () => {
    render(<StatusBar sessionId="s1" />);
    expect(screen.getByText(/2 units/)).toBeInTheDocument();
    expect(screen.getByText(/4\/5 changes/)).toBeInTheDocument();
    expect(screen.getByTestId("coverage-chip")).toHaveAttribute("data-warn", "true");
  });
});
```

To make `StatusBar` importable, add `export` to its declaration in `App.tsx` (`export function StatusBar(...)`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @crw/web exec vitest run test/StatusBar.test.tsx`
Expected: FAIL — `StatusBar` not exported / chip missing.

- [ ] **Step 3: Implement**

In `App.tsx`: `export` the `StatusBar` function. Replace the `{unit && (<Field …>)}` block with a coverage chip:

```tsx
{coverage && (
  <div
    className="statusbar__field"
    data-testid="coverage-chip"
    data-warn={coverage.unassigned > 0}
    style={{ color: coverage.unassigned > 0 ? "var(--warn, #d98a2b)" : "var(--text)" }}
  >
    <span style={{ color: "var(--dim)", fontSize: 13, letterSpacing: "0.08em" }}>PLAN</span>
    <span style={{ fontSize: 15, fontVariantNumeric: "tabular-nums" }}>
      {units.length} units · {coverage.covered}/{coverage.changedTotal} changes
    </span>
  </div>
)}
```

Add near the top of `StatusBar`:

```tsx
const coverage = sessionData?.coverage;
const units = sessionData?.units ?? [];
```

(`sessionData` already exists in `StatusBar`. Remove the now-unused `const unit = sessionData?.units?.[0];`.)

- [ ] **Step 4: Run tests + full web suite**

Run: `pnpm --filter @crw/web test && pnpm --filter @crw/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/App.tsx packages/web/test/StatusBar.test.tsx
git commit -m "feat(web): coverage chip in status bar

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Vda4vMpYdtb1bZeevrtjzy"
```

---

### Task 13: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run every package's tests + typecheck**

```bash
pnpm -r test
pnpm -r typecheck
```

Expected: all PASS.

- [ ] **Step 2: Manual smoke (optional but recommended)**

Start the server and web dev, create a session against a real branch, run `orchestrate plan-context`, write a `plan.json`, run `submit-plan`, and confirm the Plan view shows units with a coverage chip and (if any) an "Unassigned changes" unit. Use the `verify` or `run` skill if available.

- [ ] **Step 3: Commit any fixups, then finish the branch**

Use `superpowers:finishing-a-development-branch` to open the PR / merge.

---

## Self-Review

**1. Spec coverage**

| Spec item | Task |
|---|---|
| Orphan set computed + exposed on `/flows` | 5 |
| Kind-tagged units, drop `unit_id`, derived membership | 3 |
| Plan API `{ kind, flowEntryStableId | orphanStableIds, label, rationale? }` | 3, 4 |
| Coverage reconciliation → auto "Unassigned changes" | 4 |
| `coverage` on PUT /plan and GET session | 4 |
| Compact change summary, no diff bodies | 1, 6 |
| `orchestrate plan-context / diff / submit-plan`, default partition | 7 |
| skill.md "Building the review plan" + no-`git diff` rule | 8 |
| Plan view groups by unit; flow-units as tracks, orphan-units as chips; auto-unit warning | 11 |
| Coverage chip in status bar | 12 |
| Remove GraphView/FrontierStrip/ViewToggle/viewMode/deps; keep NodeBadge & /nodes | 9, 10 |
| Shared node reviewed-state across units (per-node review_status) | inherent — review status lives on the node; PlanView reads it per member (11) |
| Tests for coverage math, orphan set, change summary, default partition, Plan view | 2, 4, 5, 6, 7, 11, 12 |

No uncovered spec requirement found.

**2. Placeholder scan:** The only literal placeholder is the empty-state glyph in Task 11 (flagged inline to replace with `⌖`). All code steps contain complete code.

**3. Type consistency:** `Unit` (kind/memberStableIds/auto) is defined identically in server `types.ts` (Task 3) and web `client.ts` (Task 9). `Coverage` fields `{ changedTotal, covered, unassigned }` match across Tasks 4, 9, 12. `PlanUnitInput`/`UnitInput` flow shape (`flowEntryStableId`) and orphan shape (`orphanStableIds`) match across server (2,3,4), skill (7), and web (9). `Flow.entryStableId` added in server route (5) and consumed in web (9, 11). `computeCoverage` matches steps in flows by `steps[0].stableId` (Task 2), and the route maps `entryStableId = f.steps[0]?.stableId` (Task 5) — consistent.
