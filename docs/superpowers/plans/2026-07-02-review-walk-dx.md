# Review-Walk DX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fluent review loop — walk order + next-unreviewed, keyboard, persisted position, unit collapse + bulk-mark, editable plan, per-unit test chip, stale-session indicator.

**Architecture:** A pure `buildWalkOrder` selector derives the canonical sequence from data the Plan view already fetches; keyboard + navigation sit in `SplitLayout`; UI state persists via zustand `persist` keyed by session. Server side: one new `PATCH /units/:unitId` route and a `head_sha` column + `stale` flag. Spec: `docs/superpowers/specs/2026-07-02-review-walk-dx-design.md`.

**Tech Stack:** TypeScript strict, Hono, zustand (`persist` middleware), TanStack Query, vitest + React Testing Library.

## Global Constraints

- Keyboard map: `j`/`k` next/prev, `n` next unreviewed, `r` mark reviewed-clean + advance, `c` focus comment box, `?` shortcut overlay. All inert while focus is in an input/textarea/contentEditable.
- Walk order: units by `position`; flow-units in step order; orphan-units in `memberStableIds` order; changed nodes only; dedupe by nodeId (first occurrence).
- The auto "Unassigned changes" unit is not renamable/reorderable (server 400).
- Test chip hidden when a unit has no linked tests; warning tint when tests exist but none changed.
- `stale` degrades silently when git is unavailable.
- localStorage key: `srev-ui:<sessionId>`.

---

### Task 1: `head_sha` + `stale` flag (server)

**Files:**
- Modify: `packages/server/src/db/schema.ts`, `packages/server/src/repo/sessions.ts`, `packages/server/src/routes/sessions.ts` (POST + GET), `packages/server/src/diff.ts` (add `gitHeadSha`), `packages/server/src/types.ts` (ReviewSession.headSha)
- Test: `packages/server/test/routes.test.ts` (extend)

**Interfaces:**
- Produces: `gitHeadSha(root?: string): string | null`; `createSession(db, branch, baseRef, headSha: string)`; `GET /api/sessions/:id` response gains `stale?: boolean`.

- [ ] **Step 1: Write the failing test** (uses the fixture git repo pattern from the residual tests — a session created against a repo whose HEAD then moves):

```ts
describe("stale session indicator", () => {
  it("reports stale=false right after creation and true after HEAD moves", async () => {
    const { execFileSync } = await import("node:child_process");
    const { writeFileSync } = await import("node:fs");
    const g = (...a: string[]) => execFileSync("git", a, { cwd: fixtureRoot, encoding: "utf8" });
    g("init", "-b", "main");
    g("config", "user.email", "t@t"); g("config", "user.name", "t");
    writeFileSync(join(fixtureRoot, "a.txt"), "1\n");
    g("add", "."); g("commit", "-m", "one");

    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();

    let res = await app.request(`/api/sessions/${session.id}`);
    expect((await res.json()).stale).toBe(false);

    writeFileSync(join(fixtureRoot, "a.txt"), "2\n");
    g("add", "."); g("commit", "-m", "two");
    res = await app.request(`/api/sessions/${session.id}`);
    expect((await res.json()).stale).toBe(true);
  });

  it("omits stale when the repo has no git", async () => {
    // default beforeEach fixtureRoot is not a git repo
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const res = await app.request(`/api/sessions/${session.id}`);
    expect((await res.json()).stale).toBeUndefined();
  });
});
```

(First test needs its own non-git-then-git fixture; since `beforeEach` makes a fresh `fixtureRoot`, the first test may git-init it.)

- [ ] **Step 2: Run** `pnpm --filter @srev/server exec vitest run test/routes.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.**

`diff.ts`:

```ts
/** Current HEAD sha, or null when git is unavailable. */
export function gitHeadSha(root: string = repoRoot()): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}
```

`schema.ts` — add to `review_sessions`:

```sql
  head_sha TEXT NOT NULL DEFAULT ''
```

`types.ts`: `ReviewSession` gains `headSha: string`.

`repo/sessions.ts`:

```ts
export function createSession(db: DB, branch: string, baseRef: string, headSha = ""): ReviewSession {
  const id = randomId("ses");
  const createdAt = Date.now();
  db.prepare(
    "INSERT INTO review_sessions (id, branch, base_ref, status, created_at, head_sha) VALUES (?, ?, ?, 'planning', ?, ?)"
  ).run(id, branch, baseRef, createdAt, headSha);
  return { id, branch, baseRef, status: "planning", createdAt, headSha };
}
```

(`getSession` maps `head_sha` → `headSha`.)

`routes/sessions.ts` POST: `createSession(ctx.db, body.branch, body.baseRef, gitHeadSha(ctx.repoRoot) ?? "")`.
GET `/:id`:

```ts
    const currentHead = gitHeadSha(ctx.repoRoot);
    const stale = currentHead && session.headSha ? currentHead !== session.headSha : undefined;
    return c.json({ session, units, coverage: {...}, ...(stale === undefined ? {} : { stale }) });
```

- [ ] **Step 4: Run** `pnpm --filter @srev/server exec vitest run` — Expected: PASS.

- [ ] **Step 5: Commit** `git add -A packages/server && git commit -m "feat(server): head_sha on sessions + stale flag"`

### Task 2: `PATCH /units/:unitId` (rename + reorder)

**Files:**
- Modify: `packages/server/src/routes/sessions.ts`, `packages/server/src/repo/units.ts`
- Test: `packages/server/test/routes.test.ts`

**Interfaces:**
- Produces: `PATCH /api/sessions/:id/units/:unitId` body `{ label?: string, position?: number }` → `{ units: Unit[] }` (full reindexed list). 400 for the auto unit; 404 unknown unit.
- `repo/units.ts` gains `updateUnitLabel(db, id, label)` and `setUnitPositions(db, orderedIds: string[])`.

- [ ] **Step 1: Failing tests:**

```ts
describe("PATCH /api/sessions/:id/units/:unitId", () => {
  async function makePlan() {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const pr = await app.request(`/api/sessions/${session.id}/plan`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ units: [
        { kind: "orphans", orphanStableIds: ["fn:handleOrder"], label: "A" },
        { kind: "orphans", orphanStableIds: ["fn:validateOrder"], label: "B" },
      ] }),
    });
    const { units } = await pr.json();
    return { session, units };
  }

  it("renames a unit", async () => {
    const { session, units } = await makePlan();
    const res = await app.request(`/api/sessions/${session.id}/units/${units[0].id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Renamed" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).units[0].label).toBe("Renamed");
  });

  it("moves a unit and reindexes positions densely", async () => {
    const { session, units } = await makePlan();
    const res = await app.request(`/api/sessions/${session.id}/units/${units[1].id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ position: 0 }),
    });
    const body = await res.json();
    expect(body.units.map((u: any) => u.label)).toEqual(["B", "A"]);
    expect(body.units.map((u: any) => u.position)).toEqual([0, 1]);
  });

  it("rejects edits to the auto unit", async () => {
    const { session, units } = await makePlan();
    const auto = units.find((u: any) => u.auto);
    // plan covered everything? force an auto unit by planning nothing:
    // (stub has 2 changed nodes; plan with no units → both unassigned)
    if (!auto) {
      await app.request(`/api/sessions/${session.id}/plan`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ units: [] }),
      });
    }
    const ur = await app.request(`/api/sessions/${session.id}`);
    const autoUnit = (await ur.json()).units.find((u: any) => u.auto);
    const res = await app.request(`/api/sessions/${session.id}/units/${autoUnit.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "nope" }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL (404, route missing).

- [ ] **Step 3: Implement.**

`repo/units.ts`:

```ts
export function updateUnitLabel(db: DB, id: string, label: string): void {
  db.prepare("UPDATE units SET label = ? WHERE id = ?").run(label, id);
}

/** Rewrite positions to match the given id order (dense 0..n-1). */
export function setUnitPositions(db: DB, orderedIds: string[]): void {
  const stmt = db.prepare("UPDATE units SET position = ? WHERE id = ?");
  orderedIds.forEach((id, i) => stmt.run(i, id));
}
```

`routes/sessions.ts`:

```ts
import { createUnit, getUnitsBySession, deleteUnit, updateUnitLabel, setUnitPositions } from "../repo/units.js";
// ...
  router.patch("/:id/units/:unitId", async (c) => {
    const sessionId = c.req.param("id");
    if (!getSession(ctx.db, sessionId)) return c.json({ error: "not found" }, 404);
    const units = getUnitsBySession(ctx.db, sessionId);
    const unit = units.find((u) => u.id === c.req.param("unitId"));
    if (!unit) return c.json({ error: "not found" }, 404);
    if (unit.auto) return c.json({ error: "auto unit is not editable" }, 400);
    const body = await c.req.json<{ label?: string; position?: number }>();
    if (typeof body.label === "string" && body.label.trim()) updateUnitLabel(ctx.db, unit.id, body.label.trim());
    if (typeof body.position === "number") {
      const ids = units.map((u) => u.id).filter((id) => id !== unit.id);
      ids.splice(Math.max(0, Math.min(body.position, ids.length)), 0, unit.id);
      setUnitPositions(ctx.db, ids);
    }
    return c.json({ units: getUnitsBySession(ctx.db, sessionId) });
  });
```

- [ ] **Step 4: Run** `pnpm --filter @srev/server exec vitest run test/routes.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** `git add -A packages/server && git commit -m "feat(server): PATCH unit rename/reorder with dense reindex"`

### Task 3: `buildWalkOrder` + next/prev/next-unreviewed (pure)

**Files:**
- Create: `packages/web/src/walk-order.ts`
- Test: `packages/web/test/walk-order.test.ts` (new)

**Interfaces:**
- Produces:

```ts
export interface WalkEntry { nodeId: string; stableId: string; }
export function buildWalkOrder(units: Unit[], flows: Flow[], nodes: Node[]): WalkEntry[];
export function nextInWalk(order: WalkEntry[], currentNodeId: string | null, dir: 1 | -1): string | null;
export function nextUnreviewed(order: WalkEntry[], nodes: Node[], currentNodeId: string | null): string | null;
```

- [ ] **Step 1: Failing tests** (`walk-order.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { buildWalkOrder, nextInWalk, nextUnreviewed } from "../src/walk-order.js";
import type { Unit, Flow, Node } from "../src/api/client.js";

const node = (id: string, review = "unreviewed"): Node => ({
  id: `n-${id}`, sessionId: "s", stableId: id, label: id, file: "f.ts", startLine: 1, endLine: 2,
  changeStatus: "changed", reviewStatus: review as Node["reviewStatus"], reviewedInUnit: null, isTest: false,
});
const step = (id: string, changed = true) => ({
  stableId: id, label: id, file: "f.ts", startLine: 1, endLine: 2, isTest: false, depth: 0,
  nodeId: changed ? `n-${id}` : null, changeStatus: changed ? "changed" as const : null, reviewStatus: null,
});
const unit = (id: string, kind: "flow" | "orphans", members: string[], position: number): Unit => ({
  id, sessionId: "s", position, label: id, rationale: "", kind, memberStableIds: members, auto: false,
});

describe("buildWalkOrder", () => {
  it("orders units by position, flows in step order, orphans in member order, deduped", () => {
    const flows: Flow[] = [{
      id: 1, name: "f", criticality: 0, depth: 1, affected: true, entryStableId: "e",
      changedStableIds: ["e", "shared"],
      steps: [step("e"), step("shared"), step("ctx", false)],
    }];
    const units = [unit("u2", "orphans", ["shared", "orphan1"], 1), unit("u1", "flow", ["e"], 0)];
    const nodes = [node("e"), node("shared"), node("orphan1")];
    expect(buildWalkOrder(units, flows, nodes).map((w) => w.stableId)).toEqual(["e", "shared", "orphan1"]);
  });
});

describe("navigation", () => {
  const order = [{ nodeId: "n-a", stableId: "a" }, { nodeId: "n-b", stableId: "b" }, { nodeId: "n-c", stableId: "c" }];
  it("nextInWalk steps and wraps", () => {
    expect(nextInWalk(order, "n-a", 1)).toBe("n-b");
    expect(nextInWalk(order, "n-c", 1)).toBe("n-a");
    expect(nextInWalk(order, "n-a", -1)).toBe("n-c");
    expect(nextInWalk(order, null, 1)).toBe("n-a");
    expect(nextInWalk([], null, 1)).toBeNull();
  });
  it("nextUnreviewed skips reviewed nodes and wraps past current", () => {
    const nodes = [node("a", "reviewed-clean"), node("b", "reviewed-clean"), node("c")];
    expect(nextUnreviewed(order, nodes, "n-a")).toBe("n-c");
    const allDone = [node("a", "reviewed-clean"), node("b", "reviewed-clean"), node("c", "reviewed-commented")];
    expect(nextUnreviewed(order, allDone, "n-a")).toBeNull();
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter @srev/web exec vitest run test/walk-order.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** `packages/web/src/walk-order.ts`:

```ts
import type { Unit, Flow, Node } from "./api/client.js";

export interface WalkEntry { nodeId: string; stableId: string; }

/** Canonical review sequence: units by position; flow steps in tree order;
 *  orphan members in listed order; changed nodes only; first occurrence wins. */
export function buildWalkOrder(units: Unit[], flows: Flow[], nodes: Node[]): WalkEntry[] {
  const flowByEntry = new Map(flows.map((f) => [f.entryStableId, f]));
  const nodeByStable = new Map(nodes.map((n) => [n.stableId, n]));
  const seen = new Set<string>();
  const order: WalkEntry[] = [];
  const push = (stableId: string, nodeId: string | null) => {
    if (!nodeId || seen.has(nodeId)) return;
    seen.add(nodeId);
    order.push({ nodeId, stableId });
  };
  for (const u of [...units].sort((a, b) => a.position - b.position)) {
    if (u.kind === "flow") {
      for (const entry of u.memberStableIds) {
        for (const s of flowByEntry.get(entry)?.steps ?? []) {
          if (s.changeStatus === "changed") push(s.stableId, s.nodeId);
        }
      }
    } else {
      for (const stableId of u.memberStableIds) {
        const n = nodeByStable.get(stableId);
        if (n && n.changeStatus === "changed") push(stableId, n.id);
      }
    }
  }
  return order;
}

export function nextInWalk(order: WalkEntry[], currentNodeId: string | null, dir: 1 | -1): string | null {
  if (order.length === 0) return null;
  const i = currentNodeId ? order.findIndex((w) => w.nodeId === currentNodeId) : -1;
  if (i === -1) return order[dir === 1 ? 0 : order.length - 1].nodeId;
  return order[(i + dir + order.length) % order.length].nodeId;
}

export function nextUnreviewed(order: WalkEntry[], nodes: Node[], currentNodeId: string | null): string | null {
  const statusById = new Map(nodes.map((n) => [n.id, n.reviewStatus]));
  const start = currentNodeId ? order.findIndex((w) => w.nodeId === currentNodeId) : -1;
  for (let k = 1; k <= order.length; k++) {
    const w = order[(start + k) % order.length];
    if (statusById.get(w.nodeId) === "unreviewed") return w.nodeId;
  }
  return null;
}
```

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** `git add packages/web/src/walk-order.ts packages/web/test/walk-order.test.ts && git commit -m "feat(web): pure walk-order + navigation selectors"`

### Task 4: Keyboard + nav buttons + persisted position

**Files:**
- Modify: `packages/web/src/store/ui.ts` (persist), `packages/web/src/components/SplitLayout.tsx` (keyboard, footer buttons), `packages/web/src/components/CommentBox.tsx` (focusable textarea ref hook)
- Test: `packages/web/test/SplitLayout.test.tsx` (new)

**Interfaces:**
- Consumes: Task 3 selectors; existing `useUpdateNodeStatus`.
- Produces: `useUIStore` persisted (`currentNodeId`, `splitRatio`, `collapsedUnits: string[]`) under `srev-ui:<sessionId>`; footer gains "Next unreviewed →" (`data-testid="next-unreviewed"`); global keydown handler; CommentBox textarea gets `data-testid="comment-input"`.

- [ ] **Step 1: Failing tests** (`SplitLayout.test.tsx`, mock hooks the same way `PlanView.test.tsx` does; fixtures: 2 changed nodes n-a unreviewed, n-b unreviewed, one orphan unit):

```tsx
  it("advances to the next unreviewed node on 'n' and via the footer button", async () => {
    render(<SplitLayout sessionId="s1" currentNodeId={null} />);
    fireEvent.keyDown(window, { key: "n" });
    // store should now point at the first unreviewed node
    expect(useUIStore.getState().currentNodeId).toBe("n-a");
    fireEvent.keyDown(window, { key: "n" });
    expect(useUIStore.getState().currentNodeId).toBe("n-b");
  });

  it("marks reviewed and advances on 'r'", async () => {
    render(<SplitLayout sessionId="s1" currentNodeId="n-a" />);
    fireEvent.keyDown(window, { key: "r" });
    expect(mockUpdateStatus).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "n-a", reviewStatus: "reviewed-clean" }));
  });

  it("ignores keys while typing in the comment box", async () => {
    render(<SplitLayout sessionId="s1" currentNodeId="n-a" />);
    const input = screen.getByTestId("comment-input");
    fireEvent.keyDown(input, { key: "r" });
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement.**

`store/ui.ts` — wrap with persist, add collapse state:

```ts
import { create } from "zustand";
import { persist } from "zustand/middleware";

const sessionKey = new URLSearchParams(window.location.search).get("session") ?? "default";

interface UIState {
  splitRatio: number;
  currentUnitIndex: number;
  currentNodeId: string | null;
  walkPath: string[];
  overviewOpen: boolean;
  collapsedUnits: string[];
  // ...existing setters...
  toggleUnitCollapsed: (unitId: string) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      // ...existing state and setters unchanged...
      collapsedUnits: [],
      expandedUnits: [], // manual re-expansion of auto-collapsed (fully reviewed) units
      toggleUnitCollapsed: (unitId, currentlyCollapsed) =>
        set((s) => currentlyCollapsed
          ? { collapsedUnits: s.collapsedUnits.filter((id) => id !== unitId), expandedUnits: [...new Set([...s.expandedUnits, unitId])] }
          : { collapsedUnits: [...new Set([...s.collapsedUnits, unitId])], expandedUnits: s.expandedUnits.filter((id) => id !== unitId) }),
    }),
    {
      name: `srev-ui:${sessionKey}`,
      partialize: (s) => ({
        currentNodeId: s.currentNodeId, splitRatio: s.splitRatio,
        collapsedUnits: s.collapsedUnits, expandedUnits: s.expandedUnits,
      }),
    }
  )
);
```

(`toggleUnitCollapsed(unitId: string, currentlyCollapsed: boolean)` — the caller passes the rendered collapsed state so auto-collapsed units re-expand into `expandedUnits`; used by Task 5.)

(`window` guard: vitest web tests run under jsdom, fine.)

`SplitLayout.tsx` — inside the component:

```tsx
import { useEffect, useMemo } from "react";
import { useFlows, useNodes, useSession } from "../api/hooks.js";
import { buildWalkOrder, nextInWalk, nextUnreviewed } from "../walk-order.js";

  const { data: sessionData } = useSession(sessionId);
  const { data: flowsData } = useFlows(sessionId);
  const { data: nodesData } = useNodes(sessionId);
  const order = useMemo(
    () => buildWalkOrder(sessionData?.units ?? [], flowsData?.flows ?? [], nodesData?.nodes ?? []),
    [sessionData, flowsData, nodesData]
  );
  const nodes = nodesData?.nodes ?? [];

  const goNextUnreviewed = useCallback(() => {
    const id = nextUnreviewed(order, nodes, useUIStore.getState().currentNodeId);
    if (id) setCurrentNode(id);
  }, [order, nodes, setCurrentNode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const cur = useUIStore.getState().currentNodeId;
      if (e.key === "j") { const id = nextInWalk(order, cur, 1); if (id) setCurrentNode(id); }
      else if (e.key === "k") { const id = nextInWalk(order, cur, -1); if (id) setCurrentNode(id); }
      else if (e.key === "n") goNextUnreviewed();
      else if (e.key === "r" && cur) {
        updateStatus.mutate({ nodeId: cur, reviewStatus: "reviewed-clean" }, { onSuccess: goNextUnreviewed });
      }
      else if (e.key === "c") {
        document.querySelector<HTMLTextAreaElement>("[data-testid=comment-input]")?.focus();
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, nodes, goNextUnreviewed, setCurrentNode, updateStatus]);
```

Footer (next to "✓ Mark reviewed"):

```tsx
                <button className="btn btn--lg" data-testid="next-unreviewed" onClick={goNextUnreviewed}>
                  Next unreviewed →
                </button>
```

Render the footer row even when `currentNode` is null? No — keep the footer in the node pane; `n` works globally regardless.

`CommentBox.tsx`: add `data-testid="comment-input"` to the textarea.

The `?` shortcut overlay — a fixed-position `<dl>` listing the keys, toggled by state:

```tsx
      {showKeys && (
        <div className="keys-overlay" onClick={() => setShowKeys(false)}>
          <dl>
            <dt>j / k</dt><dd>next / previous change</dd>
            <dt>n</dt><dd>next unreviewed</dd>
            <dt>r</dt><dd>mark reviewed &amp; advance</dd>
            <dt>c</dt><dd>comment</dd>
          </dl>
        </div>
      )}
```

with `else if (e.key === "?") setShowKeys((v) => !v);` in the handler and a `.keys-overlay` style block (fixed, centered, `var(--panel)` background, `var(--line)` border).

- [ ] **Step 4: Run** `pnpm --filter @srev/web exec vitest run` — Expected: PASS.

- [ ] **Step 5: Commit** `git add -A packages/web && git commit -m "feat(web): keyboard walk, next-unreviewed, persisted position"`

### Task 5: Unit collapse + "Mark remaining reviewed"

**Files:**
- Modify: `packages/web/src/components/PlanView.tsx`, `packages/web/src/styles.css`
- Test: `packages/web/test/PlanView.test.tsx`

**Interfaces:**
- Consumes: `collapsedUnits`/`toggleUnitCollapsed` from the store; `useUpdateNodeStatus`.
- Produces: collapse chevron per unit header; auto-collapse when all changed members reviewed unless the unit id is in a manual-override; "Mark remaining reviewed" button (`window.confirm`-guarded) marking each unreviewed changed member `reviewed-clean`.

Simplification (approved deviation from the spec): manual override = presence in `collapsedUnits` is the single source of truth, with auto-collapse applied only at render for fully-reviewed units NOT manually expanded. Track manual expansion of completed units in a separate `expandedUnits: string[]` persisted alongside.

- [ ] **Step 1: Failing tests:**

```tsx
  it("collapses and expands a unit via the header chevron", async () => {
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    const chevron = (await screen.findAllByTestId("unit-collapse"))[0];
    fireEvent.click(chevron);
    expect(screen.queryByText("handleOrder")).not.toBeInTheDocument();
    fireEvent.click(chevron);
    expect(screen.getByText("handleOrder")).toBeInTheDocument();
  });

  it("marks remaining nodes reviewed after confirm", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    fireEvent.click((await screen.findAllByTestId("mark-remaining"))[0]);
    expect(mockUpdateStatus).toHaveBeenCalledTimes(2); // two unreviewed changed members in fixture
  });
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement** in `UnitBlock`:

```tsx
  const collapsedSet = useUIStore((s) => s.collapsedUnits);
  const expandedSet = useUIStore((s) => s.expandedUnits);
  const toggle = useUIStore((s) => s.toggleUnitCollapsed);
  const allReviewed = total > 0 && reviewed === total;
  const collapsed = collapsedSet.includes(unit.id) || (allReviewed && !expandedSet.includes(unit.id));

  const updateStatus = useUpdateNodeStatus(sessionId); // sessionId now a prop of UnitBlock
  // Unreviewed changed nodeIds of this unit: flow-units from their tracks' steps,
  // orphan-units (or unresolved flows) from memberNodes.
  const remaining: string[] = unit.kind === "flow" && flows.length > 0
    ? [...new Set(
        flows.flatMap((f) => f.steps)
          .filter((s) => s.changeStatus === "changed" && s.nodeId && (!s.reviewStatus || s.reviewStatus === "unreviewed"))
          .map((s) => s.nodeId as string)
      )]
    : memberNodes.filter((n) => n.changeStatus === "changed" && n.reviewStatus === "unreviewed").map((n) => n.id);
  const markRemaining = () => {
    if (!window.confirm(`Mark ${remaining.length} node${remaining.length === 1 ? "" : "s"} reviewed?`)) return;
    for (const nodeId of remaining) updateStatus.mutate({ nodeId, reviewStatus: "reviewed-clean" });
  };
```

Header additions:

```tsx
        <button data-testid="unit-collapse" className="unit__chevron" onClick={() => toggle(unit.id, collapsed)}>
          {collapsed ? "▸" : "▾"}
        </button>
        {/* ...label, badge, progress... */}
        {remaining.length > 0 && (
          <button data-testid="mark-remaining" className="unit__bulk" onClick={markRemaining} title="Mark remaining reviewed">
            ✓✓
          </button>
        )}
```

Body renders only when `!collapsed`. `toggleUnitCollapsed` must handle the auto-collapse interplay: clicking the chevron of an auto-collapsed (fully reviewed) unit adds it to `expandedUnits`; clicking on an open unit adds to `collapsedUnits`; implement `toggleUnitCollapsed(unitId, currentlyCollapsed)` accordingly:

```ts
      toggleUnitCollapsed: (unitId, currentlyCollapsed) =>
        set((s) => currentlyCollapsed
          ? { collapsedUnits: s.collapsedUnits.filter((id) => id !== unitId), expandedUnits: [...new Set([...s.expandedUnits, unitId])] }
          : { collapsedUnits: [...new Set([...s.collapsedUnits, unitId])], expandedUnits: s.expandedUnits.filter((id) => id !== unitId) }),
```

Styles: `.unit__chevron`, `.unit__bulk` — small, dim, hover-bright, no background.

- [ ] **Step 4: Run** `pnpm --filter @srev/web exec vitest run` — Expected: PASS.

- [ ] **Step 5: Commit** `git add -A packages/web && git commit -m "feat(web): unit collapse + bulk mark-remaining-reviewed"`

### Task 6: Editable plan (drag reorder + inline rename)

**Files:**
- Modify: `packages/web/src/api/client.ts` + `packages/web/src/api/hooks.ts` (add `updateUnit`), `packages/web/src/components/PlanView.tsx`
- Test: `packages/web/test/PlanView.test.tsx`

**Interfaces:**
- Consumes: Task 2's PATCH route.
- Produces: `api.updateUnit(sessionId, unitId, patch: { label?: string; position?: number })`; `useUpdateUnit(sessionId)` mutation invalidating `["session", sessionId]`; drag handle + dblclick-rename on non-auto unit headers.

- [ ] **Step 1: Failing test:**

```tsx
  it("renames a unit inline on double-click", async () => {
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    fireEvent.doubleClick(await screen.findByText("Order handling"));
    const input = screen.getByDisplayValue("Order handling");
    fireEvent.change(input, { target: { value: "Orders end-to-end" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockUpdateUnit).toHaveBeenCalledWith(expect.objectContaining({ unitId: "u1", label: "Orders end-to-end" }));
  });
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement.**

`client.ts`:

```ts
  updateUnit: (sessionId: string, unitId: string, patch: { label?: string; position?: number }) =>
    fetchJson<{ units: Unit[] }>(`/sessions/${sessionId}/units/${unitId}`, {
      method: "PATCH", body: JSON.stringify(patch),
    }),
```

`hooks.ts`:

```ts
export function useUpdateUnit(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ unitId, ...patch }: { unitId: string; label?: string; position?: number }) =>
      api.updateUnit(sessionId, unitId, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["session", sessionId] }),
  });
}
```

`PlanView.tsx` — unit header label becomes an inline-editable element for non-auto units:

```tsx
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(unit.label);
  const updateUnit = useUpdateUnit(sessionId);
  // in header:
  {editing && !unit.auto ? (
    <input
      autoFocus value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { updateUnit.mutate({ unitId: unit.id, label: draft }); setEditing(false); }
        if (e.key === "Escape") { setDraft(unit.label); setEditing(false); }
      }}
      onBlur={() => setEditing(false)}
      className="unit__name-input"
    />
  ) : (
    <h3 className="unit__name" onDoubleClick={() => !unit.auto && setEditing(true)}>{unit.label}</h3>
  )}
```

Drag reorder — HTML5 DnD on the unit wrapper (non-auto only):

```tsx
    <div
      className={`unit${unit.auto ? " unit--auto" : ""}`}
      draggable={!unit.auto}
      onDragStart={(e) => e.dataTransfer.setData("text/unit-id", unit.id)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        const draggedId = e.dataTransfer.getData("text/unit-id");
        if (draggedId && draggedId !== unit.id) {
          updateUnit.mutate({ unitId: draggedId, position: unit.position });
        }
      }}
    >
```

- [ ] **Step 4: Run** `pnpm --filter @srev/web exec vitest run` — Expected: PASS.

- [ ] **Step 5: Commit** `git add -A packages/web && git commit -m "feat(web): drag-reorder and inline rename for plan units"`

### Task 7: Per-unit test chip

**Files:**
- Modify: `packages/web/src/components/PlanView.tsx`, `packages/web/src/styles.css`
- Test: `packages/web/test/PlanView.test.tsx`

**Interfaces:**
- Consumes: `useNodes(sessionId)` — its `edges` (`GraphEdgeDTO`: `sourceNodeId`/`targetNodeId`/`edgeType: "test"`, source = production node, target = test node).
- Produces: chip `tests <changedTests>/<totalTests>` on unit headers; warning class when `total > 0 && changed === 0`; hidden when `total === 0`; click selects the first linked test node.

- [ ] **Step 1: Failing tests** (fixture: edges linking a member production node to two test nodes, one of which is changed):

```tsx
  it("shows a test chip counting changed/total linked tests", async () => {
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={onSelect} />);
    const chip = await screen.findByTestId("test-chip-u1");
    expect(chip.textContent).toContain("tests 1/2");
    fireEvent.click(chip);
    expect(onSelect).toHaveBeenCalledWith("n-test1");
  });

  it("warns when linked tests exist but none changed, hides when none linked", async () => {
    // fixture variant B: same edges but the test nodes unchanged → warn class
    // fixture variant C: no test edges → no chip
  });
```

(Write variants B and C as real tests with their own mock data, following the file's mock pattern.)

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement** — in `PlanView` compute per unit (helper co-located in `PlanView.tsx`):

```tsx
function unitTestStats(
  unitNodeIds: Set<string>,
  edges: GraphEdgeDTO[],
  nodeById: Map<string, Node>
): { total: number; changed: number; firstTestNodeId: string | null } {
  const testIds: string[] = [];
  for (const e of edges) {
    if (e.edgeType === "test" && unitNodeIds.has(e.sourceNodeId) && !testIds.includes(e.targetNodeId)) {
      testIds.push(e.targetNodeId);
    }
  }
  const changed = testIds.filter((id) => nodeById.get(id)?.changeStatus === "changed").length;
  return { total: testIds.length, changed, firstTestNodeId: testIds[0] ?? null };
}
```

`unitNodeIds` for a flow-unit = nodeIds of its flows' steps (changed and context); for an orphan-unit = member node ids. Chip in the header:

```tsx
        {testStats.total > 0 && (
          <button
            data-testid={`test-chip-${unit.id}`}
            className={`unit__tests${testStats.changed === 0 ? " unit__tests--warn" : ""}`}
            onClick={() => testStats.firstTestNodeId && onSelectNode(testStats.firstTestNodeId)}
            title="Tests linked to this unit (changed/total)"
          >
            tests {testStats.changed}/{testStats.total}
          </button>
        )}
```

Styles: `.unit__tests` small chip; `--warn` variant uses `var(--warn, #d98a2b)`.

- [ ] **Step 4: Run** `pnpm --filter @srev/web exec vitest run` — Expected: PASS.

- [ ] **Step 5: Commit** `git add -A packages/web && git commit -m "feat(web): per-unit test chip (changed/total linked tests)"`

### Task 8: Stale chip in the status bar

**Files:**
- Modify: `packages/web/src/api/client.ts` (`getSession` return type gains `stale?: boolean`), `packages/web/src/App.tsx` (StatusBar)
- Test: `packages/web/test/StatusBar.test.tsx`

**Interfaces:**
- Consumes: Task 1's `stale` field.

- [ ] **Step 1: Failing test:**

```tsx
  it("shows a stale warning chip when the repo moved past the session", async () => {
    // mock useSession to include stale: true
    render(<StatusBar sessionId="s1" />);
    expect(await screen.findByTestId("stale-chip")).toHaveTextContent("repo moved since session start");
  });
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement** — `client.ts`: `getSession` type → `{ session: ReviewSession; units: Unit[]; coverage: Coverage; stale?: boolean }`. In `StatusBar`, after the coverage chip:

```tsx
      {sessionData?.stale && (
        <div className="statusbar__field" data-testid="stale-chip" style={{ color: "var(--warn, #d98a2b)" }}>
          <span style={{ fontSize: 13, letterSpacing: "0.08em" }}>⚠</span>
          <span style={{ fontSize: 14 }}>repo moved since session start</span>
        </div>
      )}
```

- [ ] **Step 4: Run** `pnpm --filter @srev/web exec vitest run && pnpm test && pnpm typecheck` — Expected: PASS (full suite, final gate).

- [ ] **Step 5: Commit** `git add -A packages/web && git commit -m "feat(web): stale-session warning chip"`
