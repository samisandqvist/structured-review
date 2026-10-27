// Hub routes for the component map: evidence, dry-run check, submit, read.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DB } from "../src/db/connection.js";
import { createMemoryDatabase } from "../src/db/connection.js";
import { createApp } from "../src/app.js";
import { StubGraphProvider } from "../src/graph/stub.js";
import { IndexError } from "../src/graph/scip.js";
import type { ReferenceIndex, SymbolDef } from "../src/graph/references.js";

const sym = (file: string, name: string) => `scip-typescript npm fx 1.0 ${file.replace(/([^/]+)$/, "`$1`")}/${name}().`;
const GET_JOB: SymbolDef = {
  symbol: sym("src/store/jobs.ts", "getJob"),
  file: "src/store/jobs.ts",
  line: 1,
  name: "getJob",
  kind: "function",
};
const INDEX: ReferenceIndex = {
  files: ["src/api/handler.ts", "src/store/jobs.ts"],
  definitions: new Map([[GET_JOB.symbol, GET_JOB]]),
  references: [{ symbol: GET_JOB.symbol, file: "src/api/handler.ts", line: 2, caller: "handle", typeOnly: false }],
  implementations: new Map(),
  barrels: [],
  gaps: [],
};

class IndexedProvider extends StubGraphProvider {
  failure: Error | undefined;
  getReferenceIndex(): Promise<ReferenceIndex> {
    return this.failure ? Promise.reject(this.failure) : Promise.resolve(INDEX);
  }
}

const MODEL = {
  title: "Fixture",
  components: [
    { id: "app", name: "App", parent: null, paths: [""], meaning: "root" },
    { id: "store", name: "Store", parent: "app", paths: ["src/store/"], meaning: "db" },
    { id: "api", name: "API", parent: "app", paths: ["src/api/"], meaning: "api" },
    { id: "feeds", name: "Feeds", parent: null, external: true, meaning: "upstream" },
  ],
  interfaces: [
    { id: "reads", name: "Reads", provider: "store", requirers: ["api"], meaning: "r", bind: ["getJob"] },
    {
      id: "hook",
      name: "Hook",
      provider: "app",
      requirers: ["feeds"],
      meaning: "webhook",
      kind: "webhook",
      evidence: ["src/api/handler.ts"],
    },
  ],
};
const BAD_MODEL = { ...MODEL, interfaces: [{ ...MODEL.interfaces[0]!, bind: ["nothing"] }] };

let db: DB;
let root: string;
let provider: IndexedProvider;
let app: ReturnType<typeof createApp>;
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

beforeEach(() => {
  db = createMemoryDatabase();
  root = mkdtempSync(join(tmpdir(), "srev-map-"));
  git("init", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  write("src/store/jobs.ts", "// Persistence.\nexport function getJob() {}\n");
  write("src/api/handler.ts", "export function handle() {\n  getJob();\n}\n");
  git("add", ".");
  git("commit", "-m", "init");
  provider = new IndexedProvider();
  app = createApp({ db, graphProvider: provider, repoRoot: root, providerName: "scip" });
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function session(): Promise<string> {
  const res = await app.request("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
  });
  return ((await res.json()) as { session: { id: string } }).session.id;
}
const send = (path: string, method: string, body: unknown) =>
  app.request(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("component map routes", () => {
  it("serves evidence, brief by default and full on request", async () => {
    const id = await session();
    const brief = await app.request(`/api/sessions/${id}/map/evidence`);
    expect(brief.status).toBe(200);
    const body = (await brief.json()) as { scope: string; full: boolean; signals: { headers: unknown[] } };
    expect(body).toMatchObject({ scope: "src", full: false });
    expect(body.signals.headers).toEqual([{ file: "src/store/jobs.ts", comment: "Persistence." }]);
    const within = await app.request(`/api/sessions/${id}/map/evidence?within=src/store&full=1`);
    expect(await within.json()).toMatchObject({ scope: "src/store", full: true });
  });

  it("checks a model without storing it", async () => {
    const id = await session();
    const res = await send(`/api/sessions/${id}/map/check`, "POST", BAD_MODEL);
    expect(res.status).toBe(200);
    const { report } = (await res.json()) as { report: { ok: boolean; issues: { rule: string }[] } };
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.rule)).toContain("binding");
    expect((await app.request(`/api/sessions/${id}/map`)).status).toBe(404);
  });

  it("refuses to store a failing model", async () => {
    const id = await session();
    const res = await send(`/api/sessions/${id}/map`, "PUT", BAD_MODEL);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "the map fails the fidelity check", report: { ok: false } });
    expect((await app.request(`/api/sessions/${id}/map`)).status).toBe(404);
  });

  it("stores a passing model, serves it and replaces it on resubmit", async () => {
    const id = await session();
    const put = await send(`/api/sessions/${id}/map`, "PUT", MODEL);
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ report: { ok: true, coverage: { references: 1, covered: 1 } } });
    const got = (await (await app.request(`/api/sessions/${id}/map`)).json()) as Record<string, unknown>;
    expect(got).toMatchObject({ model: { title: "Fixture" }, map: { title: "Fixture" }, stale: false });
    expect(typeof got.headSha).toBe("string");
    await send(`/api/sessions/${id}/map`, "PUT", { ...MODEL, title: "Renamed" });
    expect(await (await app.request(`/api/sessions/${id}/map`)).json()).toMatchObject({ model: { title: "Renamed" } });
  });

  it("marks the map stale when the working tree changes", async () => {
    const id = await session();
    await send(`/api/sessions/${id}/map`, "PUT", MODEL);
    write("src/api/handler.ts", "export function handle() {}\n");
    expect(await (await app.request(`/api/sessions/${id}/map`)).json()).toMatchObject({
      stale: true,
      staleReason: "working-tree-changed",
    });
  });

  it("removes the map with its session", async () => {
    const id = await session();
    await send(`/api/sessions/${id}/map`, "PUT", MODEL);
    await app.request(`/api/sessions/${id}`, { method: "DELETE" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM component_maps").get()).toEqual({ n: 0 });
  });
});

describe("component map route errors", () => {
  it("answers 404 for an unknown session", async () => {
    for (const [path, method] of [
      ["/api/sessions/nope/map", "GET"],
      ["/api/sessions/nope/map", "PUT"],
      ["/api/sessions/nope/map/check", "POST"],
      ["/api/sessions/nope/map/evidence", "GET"],
    ] as const) {
      const res = method === "GET" ? await app.request(path) : await send(path, method, MODEL);
      expect(res.status).toBe(404);
    }
  });

  it("rejects a body that is not JSON", async () => {
    const id = await session();
    const res = await app.request(`/api/sessions/${id}/map/check`, { method: "POST", body: "{" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "the request body must be a JSON component model" });
    expect((await app.request(`/api/sessions/${id}/map`, { method: "PUT", body: "nope" })).status).toBe(400);
  });

  it("reports indexing failures with their phase", async () => {
    const id = await session();
    provider.failure = new IndexError("ts indexer failed for root '.'");
    const res = await app.request(`/api/sessions/${id}/map/evidence`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "ts indexer failed for root '.'", phase: "index" });
  });

  it("passes other failures on as server errors", async () => {
    const id = await session();
    provider.failure = new Error("boom");
    expect((await app.request(`/api/sessions/${id}/map/evidence`)).status).toBe(500);
  });

  it("needs a provider with a reference index", async () => {
    const plain = createApp({ db, graphProvider: new StubGraphProvider(), repoRoot: root, providerName: "stub" });
    const res = await plain.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const id = ((await res.json()) as { session: { id: string } }).session.id;
    const evidence = await plain.request(`/api/sessions/${id}/map/evidence`);
    expect(evidence.status).toBe(400);
    expect(await evidence.json()).toEqual({
      error: "component maps need the scip graph provider (current: stub)",
      phase: "map",
    });
    const unnamed = createApp({ db, graphProvider: new StubGraphProvider(), repoRoot: root });
    expect(await (await unnamed.request(`/api/sessions/${id}/map/evidence`)).json()).toMatchObject({
      error: "component maps need the scip graph provider (current: unknown)",
    });
  });
});
