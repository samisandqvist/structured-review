# Plan Narrative (Session Overview + Change-Relative Rationales) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plans gain an optional session-level `overview` narrative ("the change does X, decomposed as…") carried through submit → DB → session GET → export → `crw status` → web plan view, plus SKILL.md guidance making unit rationales change-relative.

**Architecture:** One new sqlite column on `review_sessions` (migration v9). The overview travels inside the existing plan-submit body and is replaced (or cleared when absent) on every resubmit. The server stores and serves opaque text — all generation lives in SKILL.md guidance. Spec: `docs/superpowers/specs/2026-07-25-plan-narrative-design.md`.

**Tech Stack:** TypeScript, Hono, node:sqlite, zod, vitest, React (web), pnpm workspace.

## Global Constraints

- Package manager: `pnpm` (never npm). Run tests with `pnpm test` (vitest, whole workspace) or `npx vitest run <file>` for one file.
- The plugin ships a **committed bundle**: after any `packages/skill` or `packages/server` runtime change, run `pnpm build && pnpm build:plugin` and commit the `plugin/` diff (final task).
- `overview` is optional end-to-end: `crw plan --auto` produces none; absent field on resubmit **clears** the stored value; export emits `overview: ""` when unset.
- Server never generates text; overview is trimmed but otherwise stored verbatim. No server-side length cap.
- Two skill docs exist and BOTH get the guidance edits: `packages/skill/skill.md` (dev) and `plugin/skills/code-review-walkthrough/SKILL.md` (plugin copy, hand-maintained — not generated).
- Git: work directly on `main` (repo convention: rebase + ff-only, no merge commits), commit per task.

---

### Task 1: Migration v9 — `review_sessions.overview` column + repo layer

**Files:**
- Modify: `packages/server/src/db/schema.ts`
- Modify: `packages/server/src/types.ts:21-31` (ReviewSession)
- Modify: `packages/server/src/repo/sessions.ts`
- Test: `packages/server/test/schema.test.ts`

**Interfaces:**
- Consumes: existing `MIGRATIONS` map / `SCHEMA_VERSION` pattern (schema.ts), `rowToSession` mapper.
- Produces: `ReviewSession.overview: string`; `updateSessionOverview(db: DB, id: string, overview: string): void` in `repo/sessions.js` (used by Task 2).

- [ ] **Step 1: Write the failing tests**

Append to the `describe("schema", ...)` block in `packages/server/test/schema.test.ts` (mirror the existing v2 `repo_fingerprint` test at line 48):

```ts
  it("adds overview via the v9 migration", () => {
    const db = createMemoryDatabase();
    const cols = (db.pragma("table_info(review_sessions)") as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("overview");
    db.close();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/server/test/schema.test.ts`
Expected: FAIL — `overview` not in column list.

- [ ] **Step 3: Implement**

`packages/server/src/db/schema.ts` — bump version and add the migration (the column stays OUT of baseline `SCHEMA_SQL`, same pattern as `repo_fingerprint`, so fresh DBs run 0→…→9):

```ts
export const SCHEMA_VERSION = 9;
```

and at the end of `MIGRATIONS`:

```ts
  // v9: plan-narrative overview — replaced on every plan submit (cleared when
  // the submitted plan omits it), so a replan never keeps a stale narrative.
  9: `ALTER TABLE review_sessions ADD COLUMN overview TEXT NOT NULL DEFAULT '';`,
```

`packages/server/src/types.ts` — add to `ReviewSession` after `indexWarnings`:

```ts
  /** Plan-authored narrative: what the change does and how the plan decomposes
   *  it. Empty until a plan carrying one is submitted; opaque to the server. */
  overview: string;
```

`packages/server/src/repo/sessions.ts` — thread the field through:

```ts
interface SessionRow {
  id: string; branch: string; base_ref: string; status: SessionStatus; created_at: number;
  head_sha: string; repo_fingerprint: string; index_warnings: string; overview: string;
}
```

In `rowToSession` add `overview: row.overview,`. In `createSession` the INSERT is unchanged (column default `''`); add `overview: ""` to the returned object literal. Append:

```ts
export function updateSessionOverview(db: DB, id: string, overview: string): void {
  db.prepare("UPDATE review_sessions SET overview = ? WHERE id = ?").run(overview, id);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/server/test/schema.test.ts packages/server/test/repo.test.ts`
Expected: PASS (repo.test.ts guards the createSession return-shape change).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/db/schema.ts packages/server/src/types.ts packages/server/src/repo/sessions.ts packages/server/test/schema.test.ts
git commit -m "feat(server): migration v9 — review_sessions.overview column"
```

---

### Task 2: Plan submit stores/clears the overview

**Files:**
- Modify: `packages/server/src/validate.ts:24-26` (planSchema)
- Modify: `packages/server/src/routes/sessions.ts:186-235` (PUT /:id/plan)
- Test: `packages/server/test/routes.test.ts` (inside `describe("PUT /api/sessions/:id/plan", ...)` at line 253)

**Interfaces:**
- Consumes: `updateSessionOverview` from Task 1.
- Produces: plan body accepts `{ overview?: string, units: [...] }`; PUT response gains `overview: string` (the stored, trimmed value); `GET /api/sessions/:id` returns it for free via `rowToSession`.

- [ ] **Step 1: Write the failing test**

Add to the plan describe block in `routes.test.ts` (reuse the session-create boilerplate from the test at line 254):

```ts
  it("stores a trimmed overview, returns it, and clears it on resubmit without one", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const units = [{ kind: "flow", flowEntryStableId: "fn:handleOrder", label: "Order handling" }];

    const res = await app.request(`/api/sessions/${session.id}/plan`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overview: "  Adds Redis rate limiting; units 1-2 are the config foundation.  ", units }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).overview).toBe("Adds Redis rate limiting; units 1-2 are the config foundation.");

    const info = await (await app.request(`/api/sessions/${session.id}`)).json();
    expect(info.session.overview).toBe("Adds Redis rate limiting; units 1-2 are the config foundation.");

    const res2 = await app.request(`/api/sessions/${session.id}/plan`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ units }),
    });
    expect((await res2.json()).overview).toBe("");
    const info2 = await (await app.request(`/api/sessions/${session.id}`)).json();
    expect(info2.session.overview).toBe("");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/test/routes.test.ts -t "stores a trimmed overview"`
Expected: FAIL — `overview` is `undefined` in the PUT response.

- [ ] **Step 3: Implement**

`packages/server/src/validate.ts` — extend the planSchema object (before `.superRefine`):

```ts
export const planSchema = z
  .object({
    overview: z.string().optional(),
    units: z.array(z.discriminatedUnion("kind", [flowUnitSchema, orphanUnitSchema])),
  })
```

`packages/server/src/routes/sessions.ts` — in `router.put("/:id/plan", ...)`:

1. Import `updateSessionOverview` in the existing `repo/sessions.js` import (line 3).
2. Before the transaction: `const overview = (body.overview ?? "").trim();`
3. Inside the transaction, after `updateSessionStatus(...)`: `updateSessionOverview(ctx.db, sessionId, overview);`
4. In the response: `return c.json({ units: getUnitsBySession(ctx.db, sessionId), coverage, overview });`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/server/test/routes.test.ts`
Expected: PASS, including all pre-existing plan tests (they omit `overview` — optional field, no behaviour change for them).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/validate.ts packages/server/src/routes/sessions.ts packages/server/test/routes.test.ts
git commit -m "feat(server): plan submit carries session overview (replace-on-submit)"
```

---

### Task 3: Export gains `overview`

**Files:**
- Modify: `packages/server/src/routes/comments.ts:53-62` (GET /:id/export)
- Test: `packages/server/test/routes.test.ts`

**Interfaces:**
- Consumes: `session.overview` (Task 1).
- Produces: export JSON `{ branch, baseRef, headSha, overview, comments }` — `overview: ""` when unset.

- [ ] **Step 1: Write the failing test**

Add to `routes.test.ts` (there is an existing export describe/test around `GET /api/sessions/:id/export`; add alongside it):

```ts
  it("export includes the session overview, empty string when unset", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = await cr.json();
    expect((await (await app.request(`/api/sessions/${session.id}/export`)).json()).overview).toBe("");

    await app.request(`/api/sessions/${session.id}/plan`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        overview: "One-line narrative.",
        units: [{ kind: "flow", flowEntryStableId: "fn:handleOrder", label: "Order handling" }],
      }),
    });
    expect((await (await app.request(`/api/sessions/${session.id}/export`)).json()).overview).toBe("One-line narrative.");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/test/routes.test.ts -t "export includes the session overview"`
Expected: FAIL — `overview` undefined.

- [ ] **Step 3: Implement**

In `routes/comments.ts` export handler add one line to the response object:

```ts
    return c.json({
      branch: session.branch,
      baseRef: session.baseRef,
      headSha: session.headSha,
      overview: session.overview,
      comments: exportComments(ctx.db, session.id),
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/test/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/comments.ts packages/server/test/routes.test.ts
git commit -m "feat(server): comment export carries session overview"
```

---

### Task 4: CLI plan file format + typed client

**Files:**
- Modify: `packages/skill/src/api.ts` (Session, writePlan, exportComments types; new parsePlanFile)
- Modify: `packages/skill/src/cli.ts:179-207` (cmdPlan)
- Test: `packages/skill/test/api.test.ts`

**Interfaces:**
- Consumes: server changes from Tasks 2–3.
- Produces:
  - `Session.overview?: string` (api.ts)
  - `parsePlanFile(text: string): { units: UnitInput[]; overview?: string }` — accepts a bare `UnitInput[]` (legacy format) or `{ overview?, units }`; throws `Error("plan file must be a units array or { overview?, units }")` otherwise.
  - `writePlan(base, sessionId, units, overview?)` — body `{ units, overview? }` (field omitted when `undefined`, which the server treats as clear); return type gains `overview: string`.
  - `exportComments` return type gains `overview: string` (flows through `crw comments` via the existing `...exported` spread at cli.ts:228 — no cli change needed for comments).

- [ ] **Step 1: Write the failing tests**

Add to `packages/skill/test/api.test.ts`:

```ts
import { parsePlanFile } from "../src/api.js";

describe("parsePlanFile", () => {
  it("accepts the legacy bare-array format with no overview", () => {
    const parsed = parsePlanFile(JSON.stringify([{ kind: "flow", flowEntryStableId: "fn:a", label: "A" }]));
    expect(parsed.units).toHaveLength(1);
    expect(parsed.overview).toBeUndefined();
  });

  it("accepts { overview, units }", () => {
    const parsed = parsePlanFile(JSON.stringify({
      overview: "The change does X.",
      units: [{ kind: "orphans", orphanStableIds: ["fn:b"], label: "B" }],
    }));
    expect(parsed.units).toHaveLength(1);
    expect(parsed.overview).toBe("The change does X.");
  });

  it("rejects shapes that are neither", () => {
    expect(() => parsePlanFile(JSON.stringify({ overview: "no units here" }))).toThrow(/units/);
    expect(() => parsePlanFile(JSON.stringify("nope"))).toThrow(/units/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/skill/test/api.test.ts`
Expected: FAIL — `parsePlanFile` is not exported.

- [ ] **Step 3: Implement**

`packages/skill/src/api.ts`:

1. `Session` interface: add `overview?: string;` after `indexWarnings`.
2. `exportComments` return type: `Promise<{ branch: string; baseRef: string; headSha: string; overview: string; comments: ExportedComment[] }>`.
3. `writePlan`:

```ts
export async function writePlan(
  base: string, sessionId: string, units: UnitInput[], overview?: string
): Promise<{ units: Unit[]; coverage: Coverage; overview: string }> {
  return fetchJson(`${base}/api/sessions/${sessionId}/plan`, {
    method: "PUT",
    body: JSON.stringify(overview === undefined ? { units } : { units, overview }),
  });
}
```

4. New parser next to `UnitInput`:

```ts
/** Plan file for `crw plan --units`: either a bare UnitInput[] (legacy) or
 *  { overview?, units }. The overview travels with the plan so a replan
 *  always re-states (or clears) the narrative. */
export function parsePlanFile(text: string): { units: UnitInput[]; overview?: string } {
  const raw: unknown = JSON.parse(text);
  if (Array.isArray(raw)) return { units: raw as UnitInput[] };
  if (raw && typeof raw === "object" && Array.isArray((raw as { units?: unknown }).units)) {
    const overview = (raw as { overview?: unknown }).overview;
    return {
      units: (raw as { units: UnitInput[] }).units,
      ...(typeof overview === "string" && overview.trim() ? { overview } : {}),
    };
  }
  throw new Error("plan file must be a units array or { overview?, units }");
}
```

`packages/skill/src/cli.ts` `cmdPlan`:

```ts
async function cmdPlan(base: string, flags: Record<string, string | boolean>): Promise<CommandResult> {
  const sessionId = required(flags, "session");
  let units: UnitInput[];
  let overview: string | undefined;
  if (flags.auto) {
    const { flows, orphans } = await getFlows(base, sessionId);
    units = defaultPartition(flows, orphans);
  } else if (typeof flags.units === "string") {
    ({ units, overview } = parsePlanFile(readFileSync(flags.units, "utf8")));
  } else {
    throw new Error(`plan needs --auto or --units <file.json>\n${USAGE}`);
  }
  const result = await writePlan(base, sessionId, units, overview);
  if (flags.open) launchUI(base, sessionId);
  const out = {
    coverage: result.coverage,
    ...(result.overview ? { overview: result.overview } : {}),
    units: result.units.map((u) => ({
      label: u.label, kind: u.kind, auto: u.auto, members: u.memberStableIds.length,
      attached: (u.attached ?? []).filter((m) => m.counted).length,
    })),
  };
  return {
    json: out,
    pretty: [
      `coverage: ${out.coverage.covered}/${out.coverage.changedTotal} assigned, ${out.coverage.unassigned} unassigned`,
      ...(out.overview ? [`overview: ${out.overview}`] : []),
      ...out.units.map((u) =>
        `  ${u.label}${u.auto ? " (auto)" : ""} — ${u.kind}, ${u.members} member(s)${u.attached ? `, ${u.attached} attached` : ""}`),
    ].join("\n"),
  };
}
```

Adjust the `parsePlanFile` import in cli.ts's existing `./api.js` import list.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/skill/test/api.test.ts packages/skill/test/cli.test.ts`
Expected: PASS (cli.test.ts guards cmdPlan against regressions).

- [ ] **Step 5: Commit**

```bash
git add packages/skill/src/api.ts packages/skill/src/cli.ts packages/skill/test/api.test.ts
git commit -m "feat(crw): plan file accepts { overview, units }; overview flows through plan/export"
```

---

### Task 5: `crw status` prints the overview

**Files:**
- Modify: `packages/skill/src/status.ts` (SessionStatus, computeStatus)
- Modify: `packages/skill/src/cli.ts:68-79` (prettyStatus)
- Test: `packages/skill/test/status.test.ts`

**Interfaces:**
- Consumes: `Session.overview?` (Task 4).
- Produces: `SessionStatus.overview?: string` (present only when non-empty); pretty output line `overview: <text truncated to 100 chars>` directly after the session line.

- [ ] **Step 1: Write the failing test**

Add to `packages/skill/test/status.test.ts` (build the minimal fixtures inline; match the field shapes of `SessionInfo` from `../src/api.js`):

```ts
  it("includes the session overview only when non-empty", () => {
    const base = {
      units: [], coverage: { changedTotal: 0, covered: 0, unassigned: 0 },
    };
    const withOverview = computeStatus(
      { ...base, session: { id: "s1", branch: "b", baseRef: "main", status: "walking", createdAt: 0, overview: "Adds Redis rate limiting." } },
      [], []
    );
    expect(withOverview.overview).toBe("Adds Redis rate limiting.");

    const without = computeStatus(
      { ...base, session: { id: "s1", branch: "b", baseRef: "main", status: "walking", createdAt: 0, overview: "" } },
      [], []
    );
    expect(without.overview).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/skill/test/status.test.ts`
Expected: FAIL — `overview` undefined in both cases (property doesn't exist yet), first assertion fails.

- [ ] **Step 3: Implement**

`packages/skill/src/status.ts`:

1. `SessionStatus` gains `overview?: string;` after `sessionStatus`.
2. In `computeStatus`'s return object, after `sessionStatus`:

```ts
    ...(info.session.overview ? { overview: info.session.overview } : {}),
```

`packages/skill/src/cli.ts` `prettyStatus` — insert after the session line:

```ts
function prettyStatus(s: SessionStatus): string {
  const lines = [
    `session ${s.sessionId} (${s.sessionStatus})${s.stale ? ` — STALE: ${s.staleReason}` : ""}`,
    ...(s.overview ? [`overview: ${s.overview.length > 100 ? s.overview.slice(0, 100) + "…" : s.overview}`] : []),
    `coverage: ${s.coverage.covered}/${s.coverage.changedTotal} assigned, ${s.coverage.unassigned} unassigned`,
    ...s.units.map((u) => `  [${u.reviewed}/${u.total}] ${u.label}${u.auto ? " (auto)" : ""} — ${u.kind}`),
  ];
  if (s.unreviewed.length > 0) {
    lines.push(`unreviewed (${s.unreviewed.length}):`);
    lines.push(...s.unreviewed.map((n) => `  ${n.label} — ${n.file}`));
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/skill/test/status.test.ts packages/skill/test/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/skill/src/status.ts packages/skill/src/cli.ts packages/skill/test/status.test.ts
git commit -m "feat(crw): status includes and pretty-prints the session overview"
```

---

### Task 6: Web plan view — overview block

**Files:**
- Modify: `packages/web/src/api/client.ts:1-5` (ReviewSession)
- Modify: `packages/web/src/components/PlanView.tsx:47-80`
- Modify: `packages/web/src/styles.css` (after `.unit__rationale` at line 770)
- Test: `packages/web/test/PlanView.test.tsx`

**Interfaces:**
- Consumes: `session.overview` from `GET /api/sessions/:id` (Task 2).
- Produces: `data-testid="plan-overview"` block above the unit list; absent when overview is empty/missing.

- [ ] **Step 1: Write the failing tests**

In `packages/web/test/PlanView.test.tsx`: make the mocked `useSession` overview variable. Add near the other `mock*` declarations (the `mock` prefix is required for vitest hoisting):

```ts
let mockOverview = "";
```

Change the mock's `useSession` to include a session object (it currently returns only `units`/`coverage`; PlanView reads `sessionData?.session?.overview` and `indexWarnings` optionally, so this is additive):

```ts
  useSession: () => ({ data: { session: { overview: mockOverview }, units: [
    ...unchanged unit array...
  ], coverage: { changedTotal: 3, covered: 2, unassigned: 1 } } }),
```

Reset in the existing `beforeEach`: `mockOverview = "";`. Add tests:

```ts
  it("renders the overview block above the units when the session has one", () => {
    mockOverview = "Adds Redis rate limiting; units 1-2 are the config foundation.";
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    const block = screen.getByTestId("plan-overview");
    expect(block).toHaveTextContent("Adds Redis rate limiting");
    expect(block).toHaveTextContent("from plan");
  });

  it("renders no overview block when the session has none", () => {
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    expect(screen.queryByTestId("plan-overview")).toBeNull();
  });

  it("collapses the overview on toggle", () => {
    mockOverview = "Adds Redis rate limiting.";
    render(<PlanView sessionId="s1" currentNodeId={null} onSelectNode={() => {}} />);
    fireEvent.click(screen.getByTestId("plan-overview-toggle"));
    expect(screen.queryByText("Adds Redis rate limiting.")).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/web/test/PlanView.test.tsx`
Expected: the three new tests FAIL (`plan-overview` testid not found / text still present); pre-existing tests still PASS (mock change is additive).

- [ ] **Step 3: Implement**

`packages/web/src/api/client.ts` — add to `ReviewSession`:

```ts
  /** Plan-authored narrative ("the change does X, decomposed as…"); empty
   *  until a plan carrying one is submitted. */
  overview?: string;
```

`packages/web/src/components/PlanView.tsx` — in the main return, between the `warnBanner` block and `<SessionNotes …>`:

```tsx
      {sessionData?.session?.overview && <OverviewBlock text={sessionData.session.overview} />}
```

New component at module level (below `PlanView`):

```tsx
/** Plan-authored narrative: what the change does and how the plan decomposes
 *  it. Marked "from plan" so generated text is never mistaken for tool-derived
 *  fact; collapsible because it is orientation, not workflow. */
function OverviewBlock({ text }: { text: string }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="plan__overview" data-testid="plan-overview">
      <button
        data-testid="plan-overview-toggle"
        className="plan__overview-toggle"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span style={{ fontSize: 11 }}>{collapsed ? "▸" : "▾"}</span> Overview
        <span className="plan__overview-badge">from plan</span>
      </button>
      {!collapsed && <p className="plan__overview-text">{text}</p>}
    </div>
  );
}
```

`packages/web/src/styles.css` — append after `.unit__rationale` (line 770), same visual register:

```css
.plan__overview { padding: 8px 16px 10px; border-bottom: 1px solid var(--line); }
.plan__overview-toggle { display: flex; align-items: center; gap: 6px; background: none; border: none; padding: 0; cursor: pointer; font-family: var(--display); font-weight: 500; font-size: 15px; color: var(--dim); }
.plan__overview-badge { font-size: 11px; line-height: 1.6; padding: 0 5px; border: 1px solid var(--line); border-radius: 4px; color: var(--dim); }
.plan__overview-text { margin: 6px 0 0; font-size: 14px; line-height: 1.55; white-space: pre-wrap; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/web/test/PlanView.test.tsx`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api/client.ts packages/web/src/components/PlanView.tsx packages/web/src/styles.css packages/web/test/PlanView.test.tsx
git commit -m "feat(web): collapsible plan-overview block above the unit list"
```

---

### Task 7: SKILL.md guidance — intent gathering, overview, change-relative rationales

**Files:**
- Modify: `packages/skill/skill.md` (dev copy)
- Modify: `plugin/skills/code-review-walkthrough/SKILL.md` (plugin copy — same edits; the two differ only in their invocation preamble)

**Interfaces:**
- Consumes: plan file format from Task 4 (`{ overview?, units }`).
- Produces: prose only — no code. This task is docs; no test cycle, verify by reading.

- [ ] **Step 1: Edit both files' "Building the review plan" section**

Apply the following three edits to BOTH files (section content is identical in each; plugin copy shown, lines 78–122):

**(a)** Update the plan-shape intro (line 84 region). Replace:

```
The plan is an ordered list of **units**, each either a **flow** or an **orphan group**:
```

with:

```
The plan is an optional session **overview** plus an ordered list of **units**,
each either a **flow** or an **orphan group**. The plan file is
`{ "overview": "...", "units": [...] }` (a bare units array is also accepted):
```

**(b)** In "Steps for an LLM-authored plan", insert a new step 1 before the current step 1 (renumber the rest):

```
1. Gather the change's stated intent when available: `gh pr view --json
   title,body` and `git log <base>..<branch> --format=%s` (commit subjects
   only). This is intent input, not diff reading — the "never run `git diff`"
   rule below stands. No PR or uninformative messages → proceed without;
   never block on missing intent.
```

**(c)** Replace current step 4 (the label/rationale guidance, line 110-111):

```
4. Give each unit a `label` and an optional short `rationale` describing **what
   the unit does** (its functionality/purpose) — not why you ordered it.
```

with:

```
5. Write a session `overview` (2–4 sentences, after the units are decided):
   what the change sets out to do — from stated intent when present, otherwise
   from what the diff observably does — and how the plan decomposes it
   ("units 1–2 are the config foundation, units 3–5 the consumer flows").
   State relation, never verdicts ("implements the issuance half of the token
   change", not "correctly issues tokens").
6. Give each unit a `label` and an optional short `rationale` (1–2 sentences)
   stating **what part of the overall change this unit carries**, in relation
   to the overview — not a restatement of what the code does. When a unit does
   not serve the stated intent, say so descriptively ("not part of the stated
   goal; appears to be a drive-by refactor of the retry helper") — that
   wording is the scope-creep signal; there is no separate divergence pass.
```

Renumber the remaining steps (old 5→7, old 6→8) and keep their text unchanged. In the old step 6 (submit), the sentence stays valid since `--units plan.json` now carries the overview too.

- [ ] **Step 2: Verify**

Run: `diff <(sed -n '/## Building the review plan/,/Never run `git diff`/p' packages/skill/skill.md) <(sed -n '/## Building the review plan/,/Never run `git diff`/p' plugin/skills/code-review-walkthrough/SKILL.md)`
Expected: no output (sections identical). Read both once end-to-end for renumbering mistakes.

- [ ] **Step 3: Commit**

```bash
git add packages/skill/skill.md plugin/skills/code-review-walkthrough/SKILL.md
git commit -m "docs(skill): plan narrative guidance — intent gathering, overview, change-relative rationales"
```

---

### Task 8: Full verification + plugin bundle rebuild

**Files:**
- Modify: `plugin/` (rebuilt bundle output)

**Interfaces:**
- Consumes: everything above.
- Produces: shippable state — all tests green, committed bundle current.

- [ ] **Step 1: Run the whole workspace**

Run: `pnpm build && pnpm test`
Expected: build clean, all tests PASS across server/skill/web. Fix anything red before proceeding (typecheck failures from the `ReviewSession.overview` addition would surface here).

- [ ] **Step 2: Rebuild the committed plugin bundle**

Run: `pnpm build:plugin`
Expected: `plugin/dist/crw.js` (and any other bundle outputs) change in `git status` — the CLI runtime changed in Tasks 4–5.

- [ ] **Step 3: Smoke-test the walkthrough end-to-end**

```bash
node plugin/dist/crw.js serve --repo . &
sleep 1
node plugin/dist/crw.js session create --branch HEAD --base HEAD~1
# with the printed <id>:
echo '{ "overview": "Smoke overview.", "units": [] }' > /tmp/claude-plan-smoke.json
node plugin/dist/crw.js plan --session <id> --units /tmp/claude-plan-smoke.json
node plugin/dist/crw.js status --session <id> --pretty   # expect "overview: Smoke overview."
node plugin/dist/crw.js comments --session <id>          # expect "overview": "Smoke overview."
```

Expected: overview line in pretty status; `overview` field in comments JSON. Clean up afterwards: `node plugin/dist/crw.js session delete --session <id>`, then `curl -X POST http://localhost:3456/api/shutdown` (there is no `crw shutdown` subcommand) or kill the process.

- [ ] **Step 4: Commit the bundle**

```bash
git add plugin/
git commit -m "build: rebuild committed plugin bundle for plan narrative"
```

---

## Self-Review Notes

- **Spec coverage:** migration/submit/clear semantics (Tasks 1–2), export (3), CLI plan+status+comments passthrough (4–5), web block with "from plan" affordance + collapsible + absent-when-unset (6), skill guidance incl. intent gathering and descriptive scope-creep wording (7), degradation table covered by tests in 2/3/5/6 (auto plans hit the "absent field clears / renders nothing" paths), committed-bundle rule (8).
- **Non-goals honored:** no new endpoints, no PATCH backfill, no server-side generation, no length cap server-side (CLI pretty-print truncation is display-only).
- **Type consistency:** `overview` is `string` (required, default `""`) on the server `ReviewSession`; optional (`overview?: string`) on the two clients (skill api.ts, web client.ts) since older servers may omit it. `SessionStatus.overview?` present-only-when-non-empty is deliberate (JSON output stays terse).
