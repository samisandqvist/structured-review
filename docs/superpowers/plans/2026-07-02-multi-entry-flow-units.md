# Multi-Entry Flow-Units Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A flow-unit can hold multiple entry points so Claude merges flows that review the same change; the skill sees per-flow changed sets to decide merges.

**Architecture:** `PlanUnitInput` gains `flowEntryStableIds` (singular remains accepted, normalized on write); `unitCoverage` unions changed steps across entries; the flows route exposes `stableId` per step and `changedStableIds` per flow; `PlanView` renders one track per entry and counts progress over distinct changed stableIds. Spec: `docs/superpowers/specs/2026-07-02-multi-entry-flow-units-design.md`.

**Tech Stack:** TypeScript strict, Hono, vitest, React Testing Library.

## Global Constraints

- Singular `flowEntryStableId` stays accepted forever (old plans, default partition).
- Duplicate entries within one unit are deduped on write.
- Server never merges flows itself — merging is plan input only.
- Progress counting is by distinct changed `stableId`, never per-step.

---

### Task 1: `flowEntries` normalization + multi-entry `unitCoverage`

**Files:**
- Modify: `packages/server/src/coverage.ts`
- Test: `packages/server/test/coverage.test.ts` (extend)

**Interfaces:**
- Produces: `PlanUnitInput.flowEntryStableIds?: string[]`; `flowEntries(unit: PlanUnitInput): string[]` (deduped, singular+plural merged); `unitCoverage` unions changed steps of every matched flow.

- [ ] **Step 1: Write the failing tests** — append to `coverage.test.ts` (it already builds `Flow` fixtures; follow its local helpers):

```ts
import { flowEntries } from "../src/coverage.js";

describe("flowEntries", () => {
  it("normalizes singular, plural, and both, deduped", () => {
    expect(flowEntries({ kind: "flow", flowEntryStableId: "a", label: "" })).toEqual(["a"]);
    expect(flowEntries({ kind: "flow", flowEntryStableIds: ["a", "b", "a"], label: "" })).toEqual(["a", "b"]);
    expect(flowEntries({ kind: "orphans", orphanStableIds: ["x"], label: "" })).toEqual([]);
  });
});

describe("multi-entry unitCoverage", () => {
  const flow = (entry: string, changed: string[]): Flow => ({
    id: 1, name: entry, criticality: 0, depth: 1,
    steps: [entry, ...changed].map((s, i) => ({
      stableId: s, label: s, file: "f.ts", startLine: 1, endLine: 2, isTest: false, depth: i === 0 ? 0 : 1,
    })),
  });
  it("unions changed steps across entries, counting shared nodes once", () => {
    const flows = [flow("e1", ["c1", "shared"]), flow("e2", ["c2", "shared"])];
    const changed = new Set(["c1", "c2", "shared"]);
    const unit = { kind: "flow" as const, flowEntryStableIds: ["e1", "e2"], label: "merged" };
    expect(unitCoverage(unit, flows, changed).sort()).toEqual(["c1", "c2", "shared"]);
  });
  it("an entry matching no flow contributes nothing", () => {
    const flows = [flow("e1", ["c1"])];
    const unit = { kind: "flow" as const, flowEntryStableIds: ["e1", "missing"], label: "m" };
    expect(unitCoverage(unit, flows, new Set(["c1"]))).toEqual(["c1"]);
  });
});
```

(Adjust imports to match the file's existing import of `unitCoverage` and `Flow`.)

- [ ] **Step 2: Run** `pnpm --filter @srev/server exec vitest run test/coverage.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** in `coverage.ts`:

```ts
export interface PlanUnitInput {
  kind: "flow" | "orphans";
  flowEntryStableId?: string;
  flowEntryStableIds?: string[];
  orphanStableIds?: string[];
  label: string;
  rationale?: string;
}

/** Normalized, deduped entry list for a flow-unit ([] for orphan-units). */
export function flowEntries(unit: PlanUnitInput): string[] {
  if (unit.kind !== "flow") return [];
  const list = [
    ...(unit.flowEntryStableIds ?? []),
    ...(unit.flowEntryStableId ? [unit.flowEntryStableId] : []),
  ];
  return [...new Set(list)];
}

export function unitCoverage(unit: PlanUnitInput, flows: Flow[], changed: Set<string>): string[] {
  if (unit.kind === "flow") {
    const covered = new Set<string>();
    for (const entry of flowEntries(unit)) {
      const flow = flows.find((f) => f.steps[0]?.stableId === entry);
      for (const s of flow?.steps ?? []) if (changed.has(s.stableId)) covered.add(s.stableId);
    }
    return [...covered];
  }
  return (unit.orphanStableIds ?? []).filter((id) => changed.has(id));
}
```

(Keep the existing doc comment, updated to mention the union.)

- [ ] **Step 4: Run** the coverage tests — Expected: PASS. Then `pnpm --filter @srev/server exec vitest run` — all green.

- [ ] **Step 5: Commit** `git add packages/server/src/coverage.ts packages/server/test/coverage.test.ts && git commit -m "feat(server): multi-entry flow-unit coverage union"`

### Task 2: Plan write stores all entries

**Files:**
- Modify: `packages/server/src/routes/sessions.ts` (PUT /plan)
- Test: `packages/server/test/routes.test.ts` (extend)

**Interfaces:**
- Consumes: `flowEntries` from coverage.ts.
- Produces: flow-unit `memberStableIds` = normalized entry list.

- [ ] **Step 1: Write the failing test** — in the `PUT /api/sessions/:id/plan` describe:

```ts
  it("stores multi-entry flow-units with deduped members", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const res = await app.request(`/api/sessions/${session.id}/plan`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        units: [{ kind: "flow", flowEntryStableIds: ["fn:a", "fn:b", "fn:a"], label: "merged" }],
      }),
    });
    const body = await res.json();
    expect(body.units[0].memberStableIds).toEqual(["fn:a", "fn:b"]);
  });
```

- [ ] **Step 2: Run** — Expected: FAIL (`memberStableIds` is `[undefined]`).

- [ ] **Step 3: Implement** — in `sessions.ts` PUT handler:

```ts
import { computeCoverage, flowEntries, type PlanUnitInput } from "../coverage.js";
// ...
    for (const u of body.units) {
      const members = u.kind === "flow" ? flowEntries(u) : (u.orphanStableIds ?? []);
      createUnit(ctx.db, sessionId, pos++, u.label, u.rationale ?? "", u.kind, members, false);
    }
```

- [ ] **Step 4: Run** `pnpm --filter @srev/server exec vitest run test/routes.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** `git add -A packages/server && git commit -m "feat(server): plan write accepts multi-entry flow-units"`

### Task 3: Flows route exposes `stableId` per step + `changedStableIds` per flow

**Files:**
- Modify: `packages/server/src/routes/flows.ts`
- Test: `packages/server/test/routes.test.ts` (extend the flows describe)

**Interfaces:**
- Produces: each step in `/flows` response carries `stableId: string`; each flow carries `changedStableIds: string[]` (distinct, order of first appearance).

- [ ] **Step 1: Failing test.** Stub provider has no flows, so this needs a provider with flows. Add a tiny local class in `routes.test.ts`:

```ts
import type { Flow } from "../src/graph/provider.js";

class FlowStub extends StubGraphProvider {
  override async getFlows(): Promise<Flow[]> {
    return [{
      id: 1, name: "handleOrder", criticality: 1, depth: 1,
      steps: [
        { stableId: "fn:handleOrder", label: "handleOrder", file: "src/orders.ts", startLine: 10, endLine: 30, isTest: false, depth: 0 },
        { stableId: "fn:validateOrder", label: "validateOrder", file: "src/orders.ts", startLine: 35, endLine: 50, isTest: false, depth: 1 },
        { stableId: "fn:saveOrder", label: "saveOrder", file: "src/db.ts", startLine: 100, endLine: 120, isTest: false, depth: 1 },
      ],
    }];
  }
}

describe("flows route step identity", () => {
  it("exposes stableId per step and changedStableIds per flow", async () => {
    const app2 = createApp({ db, graphProvider: new FlowStub(), repoRoot: fixtureRoot });
    const cr = await app2.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const res = await app2.request(`/api/sessions/${session.id}/flows`);
    const { flows } = await res.json();
    expect(flows[0].steps.map((s: any) => s.stableId)).toEqual(["fn:handleOrder", "fn:validateOrder", "fn:saveOrder"]);
    expect(flows[0].changedStableIds.sort()).toEqual(["fn:handleOrder", "fn:validateOrder"]);
  });
});
```

(If the diff-complete-coverage plan has landed, `repoRoot: fixtureRoot` exists; otherwise drop that property.)

- [ ] **Step 2: Run** — Expected: FAIL (`stableId`/`changedStableIds` undefined).

- [ ] **Step 3: Implement** — in `flows.ts`, inside the map:

```ts
    const flows = allFlows.map((f) => {
      const changedStableIds: string[] = [];
      const steps = f.steps.map((s) => {
        const node = byStable.get(s.stableId);
        if (node && node.changeStatus === "changed" && !changedStableIds.includes(s.stableId)) {
          changedStableIds.push(s.stableId);
        }
        return {
          stableId: s.stableId,
          label: s.label, file: s.file, startLine: s.startLine, endLine: s.endLine,
          isTest: s.isTest, depth: s.depth,
          nodeId: node?.id ?? null,
          changeStatus: node?.changeStatus ?? null,
          reviewStatus: node?.reviewStatus ?? null,
        };
      });
      const affected = changedStableIds.length > 0;
      return { id: f.id, name: f.name, criticality: f.criticality, depth: f.depth, affected, changedStableIds, entryStableId: f.steps[0]?.stableId ?? "", steps };
    });
```

- [ ] **Step 4: Run** `pnpm --filter @srev/server exec vitest run test/routes.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** `git add -A packages/server && git commit -m "feat(server): flows expose step stableId and per-flow changedStableIds"`

### Task 4: Client + skill types

**Files:**
- Modify: `packages/web/src/api/client.ts`, `packages/skill/src/orchestrate.ts`

**Interfaces:**
- Produces (web): `FlowStep.stableId: string`, `Flow.changedStableIds: string[]`, `UnitInput` flow variant `{ kind: "flow"; flowEntryStableId?: string; flowEntryStableIds?: string[]; ... }`.
- Produces (skill): same `UnitInput` shape; `FlowDTO.changedStableIds: string[]`.

- [ ] **Step 1: Edit `client.ts`:**

```ts
export interface FlowStep {
  stableId: string;
  label: string;
  // ...existing fields unchanged...
}
export interface Flow {
  // ...existing fields...
  changedStableIds: string[];
}
export type UnitInput =
  | { kind: "flow"; flowEntryStableId?: string; flowEntryStableIds?: string[]; label: string; rationale?: string }
  | { kind: "orphans"; orphanStableIds: string[]; label: string; rationale?: string };
```

Edit `orchestrate.ts`: mirror the `UnitInput` change; add `changedStableIds: string[]` to `FlowDTO`.

- [ ] **Step 2: Run** `pnpm typecheck` — Expected: PASS (types only; no behavior change).

- [ ] **Step 3: Commit** `git add packages/web/src/api/client.ts packages/skill/src/orchestrate.ts && git commit -m "feat: multi-entry UnitInput + flow changed-set types in client and skill"`

### Task 5: Plan view — one track per entry, distinct-stableId progress

**Files:**
- Modify: `packages/web/src/components/PlanView.tsx`
- Test: `packages/web/test/PlanView.test.tsx` (extend)

**Interfaces:**
- Consumes: `Flow.changedStableIds`, `FlowStep.stableId` (Task 4).
- Produces: `UnitBlock` resolves `unit.memberStableIds` → flows (all, not just `[0]`); renders a `FlowTrack` per resolved flow with a caption when >1; progress = distinct changed stableIds across tracks.

- [ ] **Step 1: Write the failing test** — follow the existing fixtures in `PlanView.test.tsx` (it mocks the API hooks); add:

```tsx
  it("renders one track per entry of a multi-entry flow-unit and dedupes progress", async () => {
    // unit fixture: kind "flow", memberStableIds: ["fn:a", "fn:b"]
    // flows fixture: two flows entered at fn:a / fn:b sharing changed step fn:shared,
    //   fn:shared reviewStatus "reviewed-clean", plus one unreviewed changed step each.
    // Expected: both flow names visible as track captions; progress reads "1/3"
    //   (distinct changed: shared + one per flow; only shared reviewed).
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    expect(await screen.findByText("flow A")).toBeInTheDocument();
    expect(screen.getByText("flow B")).toBeInTheDocument();
    expect(screen.getByText("1/3")).toBeInTheDocument();
  });
```

Build the fixture data to match the shapes the test file already uses for `useSession`/`useFlows`/`useNodes` mocks (steps must carry `stableId`).

- [ ] **Step 2: Run** `pnpm --filter @srev/web exec vitest run test/PlanView.test.tsx` — Expected: FAIL.

- [ ] **Step 3: Implement** — in `PlanView.tsx`:

```tsx
function UnitBlock({ unit, flows, nodeByStable, currentNodeId, onSelectNode }: {
  unit: Unit;
  flows: Flow[];                    // resolved flows for this unit's entries (flow-units)
  nodeByStable: Map<string, Node>;
  currentNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  const memberNodes = unit.memberStableIds.map((s) => nodeByStable.get(s)).filter((n): n is Node => !!n);

  // Progress over distinct changed stableIds across all tracks (flow-units),
  // or member nodes (orphan-units / unresolved flows).
  const changedByStable = new Map<string, FlowStep>();
  for (const f of flows) for (const s of f.steps) {
    if (s.changeStatus === "changed" && !changedByStable.has(s.stableId)) changedByStable.set(s.stableId, s);
  }
  const useFlowProgress = unit.kind === "flow" && flows.length > 0;
  const total = useFlowProgress ? changedByStable.size : memberNodes.length;
  const reviewed = useFlowProgress
    ? [...changedByStable.values()].filter((s) => s.reviewStatus && s.reviewStatus !== "unreviewed").length
    : memberNodes.filter((n) => n.reviewStatus !== "unreviewed").length;

  return (
    <div className={`unit${unit.auto ? " unit--auto" : ""}`}>
      {/* header unchanged */}
      {unit.kind === "flow" && flows.length > 0 ? (
        flows.map((f) => (
          <div key={f.entryStableId}>
            {flows.length > 1 && <div className="unit__track-caption">{f.name}</div>}
            <FlowTrack flow={f} currentNodeId={currentNodeId} onSelectNode={onSelectNode} />
          </div>
        ))
      ) : (
        /* orphan chips unchanged */
      )}
    </div>
  );
}
```

Caller in `PlanView`:

```tsx
          <UnitBlock
            key={u.id}
            unit={u}
            flows={u.kind === "flow"
              ? u.memberStableIds.map((id) => flowByEntry.get(id)).filter((f): f is Flow => !!f)
              : []}
            ...
          />
```

Add a minimal `.unit__track-caption` rule to `packages/web/src/styles.css` (dim, small, monospace — match `.unit__rationale` styling family).

- [ ] **Step 4: Run** `pnpm --filter @srev/web exec vitest run` — Expected: PASS (all web tests, including existing PlanView ones — update their fixtures if they lack `stableId` on steps).

- [ ] **Step 5: Commit** `git add -A packages/web && git commit -m "feat(web): multi-entry flow-units render per-entry tracks with deduped progress"`

### Task 6: skill.md merge guidance

**Files:**
- Modify: `packages/skill/skill.md`

- [ ] **Step 1: Edit** — replace step 2 of "Building the review plan":

```markdown
2. Make one flow-unit per **affected** flow (`flows[].affected === true`), using
   `entryStableIds: [entryStableId]`. Do not split flows. **Merge** flows into one
   multi-entry flow-unit (`flowEntryStableIds: [e1, e2, ...]`) when they substantially
   review the same change — guideline: shared `changedStableIds` ≥ half of the smaller
   flow's changed set. Label a merged unit by the shared capability, not the entry names
   (e.g. "Order validation — via API, CLI and worker"). Never merge flows with disjoint
   changed sets just to shorten the plan.
```

Also update the flow-unit shape example near the top:

```markdown
- **flow-unit** — `{ "kind": "flow", "flowEntryStableIds": ["<entry>", ...], "label": "...", "rationale": "..." }`
  (the singular `flowEntryStableId` is still accepted)
```

- [ ] **Step 2: Run** `pnpm test` — Expected: PASS.

- [ ] **Step 3: Commit** `git add packages/skill/skill.md && git commit -m "docs(skill): flow-merge guidance for multi-entry units"`
