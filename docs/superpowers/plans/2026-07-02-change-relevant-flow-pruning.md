# Change-Relevant Flow Pruning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flow trees recurse only along paths reaching a changed node; off-path callees appear as non-descended context steps; caps can never truncate a changed node.

**Architecture:** `reachesChanged` (reverse BFS) + a `relevant` parameter on `buildFlowTree` produce `offPath`-flagged steps. `GraphProvider.getFlows` gains an optional changed-set parameter, threaded from the flows route and the plan-write coverage path. `FlowTrack` collapses consecutive off-path steps into an expandable "⋯ N unchanged calls" row. Spec: `docs/superpowers/specs/2026-07-02-change-relevant-flow-pruning-design.md`.

**Tech Stack:** TypeScript strict, vitest, React Testing Library.

## Global Constraints

- Without a changed set, `buildFlowTree` behaves exactly as today (legacy path preserved).
- The entry step always renders and always descends one hop (unaffected flows keep entry + one-hop context).
- `MAX_TREE_DEPTH` (10) remains a pathology guard on recursion depth; `MAX_TREE_STEPS` (120) applies to **off-path steps only** when pruning.
- A changed step never renders inside a collapsed run.
- `getFlows(changedStableIds?)` must be passed the same changed set in **both** the flows route and the PUT /plan coverage computation.

---

### Task 1: `reachesChanged` + pruned `buildFlowTree`

**Files:**
- Modify: `packages/server/src/graph/flow-tree.ts`, `packages/server/src/graph/provider.ts` (FlowStep gains `offPath?: boolean`)
- Test: `packages/server/test/graph.test.ts` (extend — it already tests `buildFlowTree`)

**Interfaces:**
- Produces: `reachesChanged(changed: Set<string>, callAdj: Map<string, string[]>): Set<string>`; `buildFlowTree(entry, callAdj, resolve, relevant?: Set<string>)` emitting `offPath: boolean` on every step when `relevant` is given.

- [ ] **Step 1: Write the failing tests** — append to `graph.test.ts` (reuse its `resolve`/adjacency helpers if present, else define locally):

```ts
import { reachesChanged, buildFlowTree } from "../src/graph/flow-tree.js";

const info = (label: string) => ({ label, file: "f.ts", startLine: 1, endLine: 2, isTest: false });
const adj = (pairs: [string, string[]][]) => new Map(pairs);

describe("reachesChanged", () => {
  it("includes changed nodes and all transitive callers", () => {
    const callAdj = adj([["a", ["b"]], ["b", ["c"]], ["x", ["y"]]]);
    expect([...reachesChanged(new Set(["c"]), callAdj)].sort()).toEqual(["a", "b", "c"]);
  });
  it("handles cycles", () => {
    const callAdj = adj([["a", ["b"]], ["b", ["a", "c"]]]);
    expect([...reachesChanged(new Set(["c"]), callAdj)].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("buildFlowTree with relevance", () => {
  const resolve = (s: string) => info(s);
  it("descends only into relevant callees; off-path callees are leaf context", () => {
    // entry -> hot -> changed ; entry -> cold -> deep (never visited)
    const callAdj = adj([["entry", ["hot", "cold"]], ["hot", ["changed"]], ["cold", ["deep"]]]);
    const relevant = reachesChanged(new Set(["changed"]), callAdj);
    const steps = buildFlowTree("entry", callAdj, resolve, relevant);
    expect(steps.map((s) => `${s.stableId}:${s.offPath ? "off" : "on"}`)).toEqual([
      "entry:on", "hot:on", "changed:on", "cold:off",
    ]);
  });
  it("an unaffected flow keeps entry + one-hop context", () => {
    const callAdj = adj([["entry", ["a", "b"]], ["a", ["a2"]]]);
    const steps = buildFlowTree("entry", callAdj, resolve, new Set());
    expect(steps.map((s) => s.stableId)).toEqual(["entry", "a", "b"]);
    expect(steps[1].offPath).toBe(true);
  });
  it("a changed node deeper than the step cap is still present", () => {
    // chain of 3 on-path hops with 130 off-path siblings hung off the entry
    const pairs: [string, string[]][] = [["entry", ["n1", ...Array.from({ length: 130 }, (_, i) => `noise${i}`)]], ["n1", ["changed"]]];
    const callAdj = adj(pairs);
    const relevant = reachesChanged(new Set(["changed"]), callAdj);
    const steps = buildFlowTree("entry", callAdj, resolve, relevant);
    expect(steps.some((s) => s.stableId === "changed")).toBe(true);
    expect(steps.filter((s) => s.offPath).length).toBeLessThanOrEqual(120);
  });
  it("without a relevant set behaves as before (no offPath flags set true)", () => {
    const callAdj = adj([["entry", ["a"]], ["a", ["b"]]]);
    const steps = buildFlowTree("entry", callAdj, resolve);
    expect(steps).toHaveLength(3);
    expect(steps.every((s) => !s.offPath)).toBe(true);
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter @srev/server exec vitest run test/graph.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** In `provider.ts` add to `FlowStep`:

```ts
export interface FlowStep {
  stableId: string;
  label: string;
  file: string;
  startLine: number;
  endLine: number;
  isTest: boolean;
  depth: number;
  /** With relevance pruning: this step is one-hop context, not on a path to a change. */
  offPath?: boolean;
}
```

In `flow-tree.ts`:

```ts
/** Symbols from which some changed symbol is reachable via calls (incl. the changed set). */
export function reachesChanged(changed: Set<string>, callAdj: Map<string, string[]>): Set<string> {
  const rev = new Map<string, string[]>();
  for (const [src, tgts] of callAdj) {
    for (const t of tgts) {
      const callers = rev.get(t) ?? [];
      callers.push(src);
      rev.set(t, callers);
    }
  }
  const relevant = new Set(changed);
  const queue = [...changed];
  while (queue.length) {
    const sym = queue.pop()!;
    for (const caller of rev.get(sym) ?? []) {
      if (!relevant.has(caller)) { relevant.add(caller); queue.push(caller); }
    }
  }
  return relevant;
}

export function buildFlowTree(
  entry: string,
  callAdj: Map<string, string[]>,
  resolve: (sym: string) => FlowNodeInfo | undefined,
  relevant?: Set<string>
): FlowStep[] {
  const steps: FlowStep[] = [];
  let offPathCount = 0;
  const ancestors = new Set<string>();
  const walk = (sym: string, depth: number) => {
    const info = resolve(sym);
    if (!info) return;
    const onPath = !relevant || relevant.has(sym) || depth === 0;
    if (relevant && !onPath && offPathCount >= MAX_TREE_STEPS) return;
    if (!relevant && steps.length >= MAX_TREE_STEPS) return;
    steps.push({ stableId: sym, ...info, depth, offPath: relevant ? !onPath && depth > 0 : false });
    if (relevant && !onPath) { offPathCount++; return; } // context leaf: don't descend
    if (depth >= MAX_TREE_DEPTH) return;
    ancestors.add(sym);
    for (const callee of callAdj.get(sym) ?? []) {
      if (!ancestors.has(callee)) walk(callee, depth + 1);
    }
    ancestors.delete(sym);
  };
  walk(entry, 0);
  return steps;
}
```

Nuance: for an unaffected flow the entry is `onPath` by the `depth === 0` clause, so it descends one hop and its children are all off-path leaves; `offPath` on the entry itself is always `false`.

- [ ] **Step 4: Run** `pnpm --filter @srev/server exec vitest run` — Expected: PASS (fix the existing `buildFlowTree` doc comment to describe the pruned mode).

- [ ] **Step 5: Commit** `git add -A packages/server && git commit -m "feat(server): relevance-pruned flow trees with offPath context steps"`

### Task 2: Thread the changed set through providers and routes

**Files:**
- Modify: `packages/server/src/graph/provider.ts` (`getFlows(changedStableIds?: Set<string>)`), `packages/server/src/graph/scip.ts`, `packages/server/src/graph/crg.ts` + `packages/server/src/flows.ts` (CRG path), `packages/server/src/graph/stub.ts` (signature only), `packages/server/src/routes/flows.ts`, `packages/server/src/routes/sessions.ts` (PUT /plan)
- Test: `packages/server/test/routes.test.ts` (extend `FlowStub` from the multi-entry plan)

**Interfaces:**
- Produces: `GraphProvider.getFlows(changedStableIds?: Set<string>): Promise<Flow[]>`; both call sites pass `new Set(changed session node stableIds)`.

- [ ] **Step 1: Write the failing test** — extend `FlowStub` in `routes.test.ts` to prove the route passes the set:

```ts
class RecordingFlowStub extends FlowStub {
  received: Set<string> | undefined;
  override async getFlows(changedStableIds?: Set<string>): Promise<Flow[]> {
    this.received = changedStableIds;
    return super.getFlows();
  }
}

describe("flows route passes the changed set to the provider", () => {
  it("provides changed session stableIds to getFlows", async () => {
    const provider = new RecordingFlowStub();
    const app2 = createApp({ db, graphProvider: provider, repoRoot: fixtureRoot });
    const cr = await app2.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    await app2.request(`/api/sessions/${session.id}/flows`);
    expect([...(provider.received ?? [])].sort()).toEqual(["fn:handleOrder", "fn:validateOrder"]);
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL (`received` undefined / TS signature errors).

- [ ] **Step 3: Implement.**

`provider.ts`:

```ts
export interface GraphProvider {
  getChangeSubgraph(branch: string, baseRef: string): Promise<ChangeSubgraph>;
  getNeighbors(stableId: string): Promise<{ callers: GraphNode[]; callees: GraphNode[] }>;
  /** Execution flows (call trees from entry points). [] if unsupported.
   *  With changedStableIds, trees are pruned to change-relevant paths + one-hop context. */
  getFlows(changedStableIds?: Set<string>): Promise<Flow[]>;
}
```

`scip.ts`:

```ts
  async getFlows(changedStableIds?: Set<string>): Promise<Flow[]> {
    const g = await this.buildGraph();
    const relevant = changedStableIds ? reachesChanged(changedStableIds, g.callAdj) : undefined;
    // ...entries as today...
    return entries
      .map(([sym, n], i) => makeFlow(i + 1, n.label, buildFlowTree(sym, g.callAdj, resolve, relevant)))
      .filter((f) => f.steps.length > 1)
      .sort((a, b) => b.criticality - a.criticality);
  }
```

(import `reachesChanged` from `./flow-tree.js`).

`crg.ts` / `flows.ts` (CRG): thread the parameter — `readFlows(root, changedStableIds?)` computes `relevant` the same way from its `callAdj` and passes it to `buildFlowTree`; `CrgGraphProvider.getFlows(changedStableIds?)` forwards it. `stub.ts`: `async getFlows(_changedStableIds?: Set<string>) { return []; }`.

`routes/flows.ts`:

```ts
    const changed = new Set(nodes.filter((n) => n.changeStatus === "changed").map((n) => n.stableId));
    const allFlows = await ctx.graphProvider.getFlows(changed);
```

`routes/sessions.ts` PUT /plan:

```ts
    const flows = await ctx.graphProvider.getFlows(new Set(changedStableIds));
```

(move the `changedStableIds` computation above the `getFlows` call).

- [ ] **Step 4: Run** `pnpm --filter @srev/server exec vitest run && pnpm typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** `git add -A packages/server && git commit -m "feat(server): thread changed set into getFlows for pruned trees"`

### Task 3: Collapsed off-path runs in the Plan view

**Files:**
- Modify: `packages/web/src/api/client.ts` (`FlowStep.offPath?: boolean`), `packages/web/src/components/PlanView.tsx` (`FlowTrack`), `packages/web/src/styles.css`
- Test: `packages/web/test/PlanView.test.tsx` (extend)

**Interfaces:**
- Consumes: `offPath` on steps from the flows response.
- Produces: `FlowTrack` groups consecutive `offPath` steps into an expandable row labeled `⋯ N unchanged calls`.

- [ ] **Step 1: Write the failing test:**

```tsx
  it("collapses consecutive off-path steps into an expandable run", async () => {
    // flow fixture: [entry(on), ctx1(off), ctx2(off), changed(on)]
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    expect(await screen.findByText("⋯ 2 unchanged calls")).toBeInTheDocument();
    expect(screen.queryByText("ctx1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("⋯ 2 unchanged calls"));
    expect(screen.getByText("ctx1")).toBeInTheDocument();
    expect(screen.getByText("ctx2")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement** — `FlowTrack` becomes:

```tsx
function FlowTrack({ flow, currentNodeId, onSelectNode }: { flow: Flow; currentNodeId: string | null; onSelectNode: (nodeId: string) => void }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set()); // index of run start

  // Group steps into rows: singles (on-path) and runs (consecutive offPath).
  const rows: Array<{ kind: "step"; step: FlowStep; index: number } | { kind: "run"; steps: FlowStep[]; index: number }> = [];
  for (let i = 0; i < flow.steps.length; i++) {
    const s = flow.steps[i];
    if (!s.offPath) { rows.push({ kind: "step", step: s, index: i }); continue; }
    const run: FlowStep[] = [s];
    while (i + 1 < flow.steps.length && flow.steps[i + 1].offPath) run.push(flow.steps[++i]);
    rows.push({ kind: "run", steps: run, index: i - run.length + 1 });
  }

  return (
    <div className="flow__tree">
      {rows.map((row) =>
        row.kind === "step" || expanded.has(row.index) ? (
          (row.kind === "step" ? [row.step] : row.steps).map((s, j) => (
            <div key={`${row.index}-${j}`} className="flow__row" style={{ paddingLeft: s.depth * 22 }}>
              {s.depth > 0 && <span className="flow__branch">└</span>}
              <StepChip step={s} current={!!s.nodeId && s.nodeId === currentNodeId} onSelect={onSelectNode} />
            </div>
          ))
        ) : (
          <div key={`run-${row.index}`} className="flow__row" style={{ paddingLeft: row.steps[0].depth * 22 }}>
            <button
              className="flow__collapsed"
              onClick={() => setExpanded((e) => new Set(e).add(row.index))}
            >
              ⋯ {row.steps.length} unchanged call{row.steps.length === 1 ? "" : "s"}
            </button>
          </div>
        )
      )}
    </div>
  );
}
```

Add `useState` + `FlowStep` imports. Styles (`styles.css`):

```css
.flow__collapsed {
  background: none; border: 1px dashed var(--line-bright); border-radius: 4px;
  color: var(--dim); font-size: 12px; padding: 1px 8px; cursor: pointer;
}
.flow__collapsed:hover { color: var(--text); border-color: var(--text); }
```

- [ ] **Step 4: Run** `pnpm --filter @srev/web exec vitest run` — Expected: PASS (existing FlowTrack tests keep passing — steps without `offPath` render as before).

- [ ] **Step 5: Commit** `git add -A packages/web && git commit -m "feat(web): collapse off-path flow steps into expandable runs"`
