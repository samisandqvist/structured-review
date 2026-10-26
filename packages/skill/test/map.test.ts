// `srev map …`: the component-map client, its pretty output and the CLI commands.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:child_process", () => ({ spawn: vi.fn(() => ({ unref: vi.fn() })), execFileSync: vi.fn() }));

import { spawn } from "node:child_process";
import { mapUrl, prettyEvidence, prettyReport, submitMap, type MapCheckReport, type MapEvidence } from "../src/map.js";
import { runCli } from "../src/cli.js";

const BASE = "http://127.0.0.1:4999";
const REPORT: MapCheckReport = {
  ok: false,
  coverage: { references: 10, covered: 8, undeclared: 1 },
  issues: [
    { rule: "coverage", message: "'store' symbol 'getJob' is unbound", where: ["src/api/a.ts:3 (handle)"] },
    { rule: "requirer", message: "declared requirer 'x' has no call sites" },
  ],
  unclaimedFiles: [{ component: "app", files: ["src/main.ts"] }],
  unattributedReferences: 2,
  utilities: [{ id: "infra", references: 12 }],
  typeDependencies: [{ from: "api", to: "store", count: 3, symbols: ["Job"] }],
  gaps: ["cs root 'x' is not yet mapped"],
};
const EVIDENCE: MapEvidence = {
  scope: "src",
  full: false,
  tree: [{ path: "src", files: 3 }],
  roots: [{ language: "ts", root: "" }],
  candidates: [
    { id: "src/api/", files: 1 },
    { id: "src/store/", files: 2 },
  ],
  matrix: [{ from: "src/api/", to: "src/store/", references: 4 }],
  surfaces: [
    { candidate: "src/store/", symbols: 1, groups: [{ usedBy: ["src/api/"], symbols: ["getJob (src/store/a.ts:1)"] }] },
  ],
  signals: {
    implementations: [],
    barrels: [],
    headers: [{ file: "src/store/a.ts", comment: "Persistence." }],
    entryPoints: [],
    registrations: [{ file: "src/api/a.ts", line: 2, text: 'app.get("/x")' }],
  },
  gaps: [],
};

function respond(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}
function stubFetch(...responses: ReturnType<typeof respond>[]) {
  const fetchSpy = vi.fn();
  for (const r of responses) fetchSpy.mockResolvedValueOnce(r);
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}
function captureLog() {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}
const dir = mkdtempSync(join(tmpdir(), "srev-map-cli-"));
const modelFile = join(dir, "model.json");
writeFileSync(modelFile, JSON.stringify({ title: "T", components: [] }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("map client", () => {
  it("builds map URLs", () => {
    expect(mapUrl(BASE, "s1")).toBe(`${BASE}/?session=s1&view=map`);
    expect(mapUrl(BASE, "s1", "engine")).toBe(`${BASE}/?session=s1&view=map&level=engine`);
  });

  it("returns the report when the hub refuses a map", async () => {
    stubFetch(respond(422, { error: "the map fails the fidelity check", report: REPORT }));
    expect(await submitMap(BASE, "s1", {})).toEqual({ ok: false, report: REPORT });
  });

  it("throws on other hub errors", async () => {
    stubFetch(respond(404, { error: "not found" }));
    await expect(submitMap(BASE, "s1", {})).rejects.toThrow("API error 404");
  });
});

describe("pretty output", () => {
  it("lists issues by rule with locations and the coverage line", () => {
    const text = prettyReport(REPORT);
    expect(text).toContain("fidelity check: FAILED (2 issues)");
    expect(text).toContain("coverage: 8/10 cross-component references (1 undeclared)");
    expect(text).toContain("  [coverage] 'store' symbol 'getJob' is unbound\n      src/api/a.ts:3 (handle)");
    expect(text).toContain("unclaimed files under app: src/main.ts");
    expect(text).toContain("unattributed references: 2");
    expect(text).toContain("utility infra hides 12 references");
    expect(text).toContain("type-only: api -> store (3: Job)");
    expect(text).toContain("! cs root 'x' is not yet mapped");
    expect(
      prettyReport({ ...REPORT, ok: true, issues: [], unclaimedFiles: [{ component: null, files: ["x"] }] }),
    ).toContain("fidelity check: passed");
  });

  it("summarizes evidence", () => {
    const text = prettyEvidence(EVIDENCE);
    expect(text).toContain("scope: src (brief)");
    expect(text).toContain("  src/store/ (2 files)");
    expect(text).toContain("  src/api/ -> src/store/: 4");
    expect(text).toContain("  used by src/api/: getJob (src/store/a.ts:1)");
    expect(text).toContain("  src/store/a.ts: Persistence.");
    expect(text).toContain('  src/api/a.ts:2 app.get("/x")');
  });
});

describe("srev map commands", () => {
  it("prints evidence with --within and --full", async () => {
    const fetchSpy = stubFetch(respond(200, EVIDENCE));
    const log = captureLog();
    await runCli(["map", "evidence", "--session", "s1", "--port", "4999", "--within", "src/store", "--full"]);
    expect(fetchSpy.mock.calls[0]![0]).toBe(`${BASE}/api/sessions/s1/map/evidence?within=src%2Fstore&full=1`);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(EVIDENCE);
  });

  it("checks a model file and fails the exit code when the check fails", async () => {
    const fetchSpy = stubFetch(respond(200, { report: REPORT }));
    captureLog();
    await runCli(["map", "check", "--session", "s1", "--port", "4999", "--model", modelFile]);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/sessions/s1/map/check`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ title: "T", components: [] });
    expect(process.exitCode).toBe(1);
  });

  it("submits a model, prints the URL and opens it on request", async () => {
    stubFetch(respond(200, { report: { ...REPORT, ok: true, issues: [] } }));
    const log = captureLog();
    await runCli(["map", "submit", "--session", "s1", "--port", "4999", "--model", modelFile, "--open"]);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
      ok: true,
      url: `${BASE}/?session=s1&view=map`,
    });
    expect(spawn).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("reports a refused submit", async () => {
    stubFetch(respond(422, { error: "the map fails the fidelity check", report: REPORT }));
    const log = captureLog();
    await runCli(["map", "submit", "--session", "s1", "--port", "4999", "--model", modelFile, "--pretty"]);
    expect(log.mock.calls[0]![0]).toContain("map not stored");
    expect(process.exitCode).toBe(1);
  });

  it("gets the stored map", async () => {
    const stored = {
      model: { title: "T" },
      map: { report: REPORT },
      headSha: "abc",
      createdAt: 1,
      stale: true,
      staleReason: "head-moved",
    };
    stubFetch(respond(200, stored));
    const log = captureLog();
    await runCli(["map", "get", "--session", "s1", "--port", "4999"]);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
      model: { title: "T" },
      url: `${BASE}/?session=s1&view=map`,
      stale: true,
      staleReason: "head-moved",
      report: REPORT,
    });
  });

  it("requires --model and a JSON model file", async () => {
    await expect(runCli(["map", "check", "--session", "s1"])).rejects.toThrow(/^missing required flag --model/);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{");
    await expect(runCli(["map", "check", "--session", "s1", "--model", bad])).rejects.toThrow(/is not valid JSON/);
    rmSync(bad);
  });
});

describe("srev map pretty commands", () => {
  it("prints brief evidence without query flags", async () => {
    const fetchSpy = stubFetch(respond(200, { ...EVIDENCE, scope: "", full: true, gaps: ["g"] }));
    const log = captureLog();
    await runCli(["map", "evidence", "--session", "s1", "--port", "4999", "--pretty"]);
    expect(fetchSpy.mock.calls[0]![0]).toBe(`${BASE}/api/sessions/s1/map/evidence`);
    expect(log.mock.calls[0]![0]).toContain("scope: . (full)");
    expect(log.mock.calls[0]![0]).toContain("! g");
  });

  it("prints a passing check and a stored submit", async () => {
    const passed = { ...REPORT, ok: true, issues: [] };
    stubFetch(respond(200, { report: passed }), respond(200, { report: passed }));
    const log = captureLog();
    await runCli(["map", "check", "--session", "s1", "--port", "4999", "--model", modelFile, "--pretty"]);
    await runCli(["map", "submit", "--session", "s1", "--port", "4999", "--model", modelFile, "--pretty"]);
    expect(log.mock.calls[0]![0]).toContain("fidelity check: passed");
    expect(log.mock.calls[1]![0]).toContain(`map stored: ${BASE}/?session=s1&view=map`);
    expect(process.exitCode).toBeUndefined();
  });

  it("prints a stored map with and without staleness", async () => {
    const stored = { model: {}, map: { report: REPORT }, headSha: "a", createdAt: 1 };
    stubFetch(respond(200, { ...stored, stale: true, staleReason: "head-moved" }), respond(200, stored));
    const log = captureLog();
    await runCli(["map", "get", "--session", "s1", "--port", "4999", "--pretty"]);
    await runCli(["map", "get", "--session", "s1", "--port", "4999"]);
    expect(log.mock.calls[0]![0]).toContain("(stale: head-moved)");
    expect(JSON.parse(log.mock.calls[1]![0] as string)).not.toHaveProperty("stale");
  });
});
