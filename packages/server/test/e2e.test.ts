import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryDatabase } from "../src/db/connection.js";
import { createApp } from "../src/app.js";
import { ScipGraphProvider } from "../src/graph/scip.js";

/**
 * Capstone: drive the whole chain (Tasks 1-7) on a real TypeScript fixture
 * with the real SCIP provider — session -> flows -> plan -> review -> two
 * comments on one node -> export — plus the Task 3 branch contract and the
 * Task 5 working-tree staleness signal.
 */

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

/**
 * A committed 3-file TS repo (helper <- handler <- handler.test), then two
 * uncommitted working-tree edits landing inside function bodies so the
 * helper and handler nodes register as changed against baseRef HEAD.
 */
function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "crw-e2e-"));
  dir = root; // assign before any git/fs step so afterEach cleans up a partial fixture

  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "t@t");
  git(root, "config", "user.name", "t");

  // Minimal package.json + tsconfig so scip-typescript resolves the module
  // graph deterministically (bundler resolution maps the .js imports to .ts).
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", type: "module", private: true }, null, 2) + "\n");
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler", strict: true }, include: ["src"] }, null, 2) + "\n"
  );
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "helper.ts"), "export function helper(x: number): number {\n  return x + 1;\n}\n");
  writeFileSync(
    join(root, "src", "handler.ts"),
    'import { helper } from "./helper.js";\nexport function handler(): number {\n  return helper(1);\n}\n'
  );
  writeFileSync(
    join(root, "src", "handler.test.ts"),
    'import { handler } from "./handler.js";\nexport function testHandler(): boolean {\n  return handler() === 2;\n}\n'
  );
  git(root, "add", ".");
  git(root, "commit", "-m", "init fixture");

  // Uncommitted body edits — the diff reviewed with baseRef "HEAD".
  writeFileSync(join(root, "src", "helper.ts"), "export function helper(x: number): number {\n  return x + 2;\n}\n");
  writeFileSync(
    join(root, "src", "handler.ts"),
    'import { helper } from "./helper.js";\nexport function handler(): number {\n  return helper(1) + helper(2);\n}\n'
  );
  return root;
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("fixture-repo end-to-end review", () => {
  it("runs a full review through comment export", { timeout: 120_000 }, async () => {
    dir = makeFixture();
    const app = createApp({ db: createMemoryDatabase(), graphProvider: new ScipGraphProvider({ repoRoot: dir }), repoRoot: dir });

    // 1. POST /api/sessions -> 200; the change subgraph carries helper + handler
    //    and both register as changed against the working tree.
    const cr = await app.request("/api/sessions", json({ branch: "HEAD", baseRef: "HEAD" }));
    expect(cr.status).toBe(200);
    const { session, subgraph } = await cr.json();
    expect(session.id).toBeDefined();
    const subLabels = new Set<string>(subgraph.nodes.map((n: any) => n.label));
    expect(subLabels.has("helper")).toBe(true);
    expect(subLabels.has("handler")).toBe(true);
    const sid: string = session.id;

    const nodesRes = await app.request(`/api/sessions/${sid}/nodes`);
    const { nodes } = await nodesRes.json();
    const changed = nodes.filter((n: any) => n.changeStatus === "changed");
    const changedLabels = new Set<string>(changed.map((n: any) => n.label));
    expect(changedLabels.has("helper")).toBe(true);
    expect(changedLabels.has("handler")).toBe(true);

    // 2. GET /flows -> SCIP traces the handler -> helper call as a flow. The
    //    handler's only caller is a test, which must not disqualify it as an
    //    entry point. Secondary invariant: every changed node appears on a
    //    flow step or in the orphan set.
    const flowsRes = await app.request(`/api/sessions/${sid}/flows`);
    expect(flowsRes.status).toBe(200);
    const { flows, orphans } = await flowsRes.json();
    const handlerFlow = flows.find((f: any) => {
      const labels = new Set(f.steps.map((s: any) => s.label));
      return labels.has("handler") && labels.has("helper");
    });
    expect(handlerFlow).toBeDefined();
    expect(handlerFlow.affected).toBe(true);
    // handler is exported (`export function handler`) and heads the call tree
    // as a graph root (its only caller, testHandler, is a test) -> 0.7.
    expect(handlerFlow.entryReasons).toEqual(["graph-root", "exported"]);
    expect(handlerFlow.entryConfidence).toBe(0.7);
    const inFlowsOrOrphans = new Set<string>([
      ...flows.flatMap((f: any) => f.steps.map((s: any) => s.stableId)),
      ...orphans.map((o: any) => o.stableId),
    ]);
    for (const n of changed) expect(inFlowsOrOrphans.has(n.stableId)).toBe(true);

    // 3. PUT /plan with one unit covering every changed node -> nothing unassigned.
    const changedStableIds = changed.map((n: any) => n.stableId);
    const planRes = await app.request(`/api/sessions/${sid}/plan`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ units: [{ kind: "orphans", orphanStableIds: changedStableIds, label: "Everything" }] }),
    });
    expect(planRes.status).toBe(200);
    const plan = await planRes.json();
    expect(plan.coverage.changedTotal).toBe(changedStableIds.length);
    expect(plan.coverage.unassigned).toBe(0);
    expect(plan.units.some((u: any) => u.auto)).toBe(false);

    // 4. GET /nodes; pick the helper node.
    const helperNode = changed.find((n: any) => n.label === "helper");
    expect(helperNode).toBeDefined();
    const helperId: string = helperNode.id;

    // 5. POST two comments on the helper node.
    for (const text of ["first", "second"]) {
      const res = await app.request(`/api/sessions/${sid}/comments`, json({ nodeId: helperId, text }));
      expect(res.status).toBe(200);
    }

    // 6. PATCH helper reviewed-clean -> normalized to reviewed-commented (Task 6).
    const patchRes = await app.request(`/api/sessions/${sid}/nodes/${helperId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewStatus: "reviewed-clean" }),
    });
    expect(patchRes.status).toBe(200);
    expect((await patchRes.json()).node.reviewStatus).toBe("reviewed-commented");

    // 7. GET /export -> ordered array of two comments, each with stableId + file (Task 1),
    //    plus a server-derived hunk snippet and structural context naming a real neighbor (Task 3).
    const exportRes = await app.request(`/api/sessions/${sid}/export`);
    expect(exportRes.status).toBe(200);
    const exportBody = await exportRes.json();
    expect(exportBody.branch).toBe("HEAD");
    expect(typeof exportBody.headSha).toBe("string");
    expect(exportBody.baseRef).toBeTruthy();
    const { comments } = exportBody;
    expect(comments).toHaveLength(2);
    expect(comments.map((c: any) => c.text)).toEqual(["first", "second"]);
    for (const c of comments) {
      expect(c.stableId).toBe(helperNode.stableId);
      expect(c.file).toBe("src/helper.ts");
      expect(c.startLine).toBe(helperNode.startLine);
      expect(c.endLine).toBe(helperNode.endLine);
      expect(c.hunkSnippet.length).toBeGreaterThan(0);
      expect(c.hunkSnippet).toMatch(/^\+/m);
      // helper's only caller in the fixture is handler.
      expect(c.structuralContext).toContain("handler");
    }

    // 8. Edit helper again (HEAD unchanged) -> stale via content fingerprint (Task 5).
    writeFileSync(join(dir, "src", "helper.ts"), "export function helper(x: number): number {\n  return x + 3;\n}\n");
    const staleRes = await app.request(`/api/sessions/${sid}`);
    const staleBody = await staleRes.json();
    expect(staleBody.stale).toBe(true);
    expect(staleBody.staleReason).toBe("working-tree-changed");
  });

  it("rejects a session for a non-checked-out branch", async () => {
    dir = makeFixture();
    const app = createApp({ db: createMemoryDatabase(), graphProvider: new ScipGraphProvider({ repoRoot: dir }), repoRoot: dir });
    const res = await app.request("/api/sessions", json({ branch: "release", baseRef: "HEAD" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/release/);
    expect(body.phase).toBe("resolve-ref");
  });
});
