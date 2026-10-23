// packages/skill/test/cli.test.ts — pure pieces of the CLI: arg parsing,
// the serve reuse/spawn/conflict decision, and response shaping.
import { describe, it, expect, afterEach, vi } from "vitest";
import { parseCliArgs, planOutput, prettyBrief, runCli } from "../src/cli.js";
import { decideServe, statePaths } from "../src/serve.js";

describe("parseCliArgs", () => {
  it("joins positionals into a command and collects value flags", () => {
    const { command, flags } = parseCliArgs(["session", "create", "--branch", "feat/x", "--base", "main"]);
    expect(command).toBe("session create");
    expect(flags).toEqual({ branch: "feat/x", base: "main" });
  });

  it("treats auto/open/pretty as boolean flags", () => {
    const { command, flags } = parseCliArgs(["plan", "--session", "s1", "--auto", "--pretty"]);
    expect(command).toBe("plan");
    expect(flags).toEqual({ session: "s1", auto: true, pretty: true });
  });

  it("parses flags that take values even when a boolean flag follows", () => {
    const { flags } = parseCliArgs(["serve", "--repo", "/tmp/x", "--port", "4000"]);
    expect(flags).toEqual({ repo: "/tmp/x", port: "4000" });
  });
});

describe("planOutput", () => {
  const base = {
    coverage: { changedTotal: 2, covered: 2, unassigned: 0 },
    overview: "",
    units: [{ id: "u1", label: "A", kind: "flow" as const, memberStableIds: ["e1"], auto: false, attached: [] }],
  };

  it("always includes unassigned, [] at full coverage (issue #10)", () => {
    const out = planOutput({ ...base, unassigned: [] });
    expect(out.unassigned).toEqual([]);
    expect("unassigned" in out).toBe(true);
  });

  it("lists unassigned leftovers and counts only counted attachments", () => {
    const out = planOutput({
      ...base,
      coverage: { changedTotal: 3, covered: 2, unassigned: 1 },
      units: [
        {
          ...base.units[0],
          attached: [
            { stableId: "t1", parentStableId: "e1", reason: "tested-by" as const, counted: true },
            { stableId: "t2", parentStableId: "e1", reason: "same-file" as const, counted: false },
          ],
        },
      ],
      unassigned: [{ stableId: "x", label: "x", file: "x.ts" }],
    });
    expect(out.unassigned).toHaveLength(1);
    expect(out.units[0]).toEqual({ label: "A", kind: "flow", auto: false, members: 1, attached: 1 });
  });
});

describe("prettyBrief", () => {
  it("renders flows, merges, orphan groups and changes as a scannable table", () => {
    const text = prettyBrief(
      {
        flows: [{ id: 127, name: "handleOrder", entry: "handleOrder — src/orders.ts", changedCount: 2 }],
        mergeSuggestions: [{ group: 0, flowIds: [127, 142], names: ["handleOrder", "processOrder"] }],
        orphanGroups: [{ dir: "docs", files: ["docs/x.md"] }],
        changes: [
          {
            file: "src/orders.ts",
            lines: "10-42",
            label: "handleOrder",
            kind: "function",
            status: "modified",
            added: 12,
            removed: 3,
          },
        ],
      },
      ["feat: orders"],
    );
    expect(text).toContain("commits:\n  feat: orders");
    expect(text).toContain("[127] handleOrder (2 changed) — handleOrder — src/orders.ts");
    expect(text).toContain("[group 0] flows 127+142 — handleOrder, processOrder");
    expect(text).toContain("docs — docs/x.md");
    expect(text).toContain("src/orders.ts:10-42 handleOrder (function, modified +12/-3)");
  });

  it("omits empty sections", () => {
    const text = prettyBrief({ flows: [], mergeSuggestions: [], orphanGroups: [], changes: [] });
    expect(text).not.toContain("merge suggestions");
    expect(text).not.toContain("orphan groups");
    expect(text).not.toContain("commits");
  });
});

describe("statePaths", () => {
  afterEach(() => {
    delete process.env.SREV_DATA_DIR;
  });

  it("keeps state in the repo without SREV_DATA_DIR", () => {
    expect(statePaths("/home/x/repo")).toEqual({ logDir: "/home/x/repo/.srev" });
  });

  it("keys DB and logs by repo name + path hash under the data dir", () => {
    process.env.SREV_DATA_DIR = "/data";
    const a = statePaths("/home/x/repo");
    const b = statePaths("/home/y/repo"); // same basename, different path
    expect(a.dbPath).toMatch(/^\/data\/db\/repo-[0-9a-f]+\.db$/);
    expect(a.logDir).toMatch(/^\/data\/logs\/repo-[0-9a-f]+$/);
    expect(a.dbPath).not.toBe(b.dbPath);
    expect(statePaths("/home/x/repo")).toEqual(a); // deterministic
  });
});

describe("decideServe", () => {
  const ROOT = "/home/x/repo";
  it("spawns when nothing answers /health", () => {
    expect(decideServe(null, ROOT)).toEqual({ action: "spawn" });
  });
  it("reuses a healthy hub serving the same repo", () => {
    expect(decideServe({ ok: true, repoRoot: ROOT, pid: 1 }, ROOT)).toEqual({ action: "reuse" });
  });
  it("conflicts on a hub serving a different repo", () => {
    const d = decideServe({ ok: true, repoRoot: "/other", pid: 42 }, ROOT);
    expect(d.action).toBe("conflict");
    expect((d as { reason: string }).reason).toContain("/other");
  });
  it("conflicts on an unknown /health responder", () => {
    const d = decideServe({ ok: true }, ROOT);
    expect(d.action).toBe("conflict");
  });
});

describe("runCli", () => {
  it("prints usage without a command and rejects an unknown one", async () => {
    await expect(runCli([])).rejects.toThrow(/^usage:/);
    await expect(runCli(["bogus"])).rejects.toThrow(/^unknown command: bogus\nusage:/);
    await expect(runCli(["constructor"])).rejects.toThrow(/^unknown command: constructor/);
  });
});

describe("runCli shape", () => {
  const shape = { source: "inferred", warnings: [], components: [], unassigned: [], outsideConsumers: [] };
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("prints the session's shape as JSON, or as text with --pretty, from the hub on --port", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => shape }));
    vi.stubGlobal("fetch", fetchSpy);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCli(["shape", "--session", "s1", "--port", "4999"]);
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://127.0.0.1:4999/api/sessions/s1/shape");
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(shape);
    await runCli(["shape", "--session", "s1", "--pretty"]);
    expect(log.mock.calls[1]![0]).toBe("Components (inferred):");
  });

  it("requires --session", async () => {
    await expect(runCli(["shape"])).rejects.toThrow(/^missing required flag --session/);
  });
});

describe("runCli status --pretty", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("summarizes a stale session with a long overview, an auto unit and unreviewed changes", async () => {
    const node = {
      id: "n1",
      stableId: "fn:a",
      label: "a",
      file: "a.ts",
      changeStatus: "changed",
      reviewStatus: "unreviewed",
    };
    const info = {
      session: { id: "s1", status: "walking", overview: "x".repeat(120) },
      units: [{ id: "u1", label: "Leftovers", kind: "orphans", memberStableIds: ["fn:a"], auto: true, attached: [] }],
      coverage: { changedTotal: 1, covered: 1, unassigned: 0 },
      stale: true,
      staleReason: "working tree changed",
    };
    const bodies: Record<string, unknown> = {
      "/api/sessions/s1": info,
      "/api/sessions/s1/nodes": { nodes: [node] },
      "/api/sessions/s1/flows": { flows: [], orphans: [] },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => bodies[new URL(url).pathname] })),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCli(["status", "--session", "s1", "--pretty"]);
    expect(log.mock.calls[0]![0]).toBe(
      [
        "session s1 (walking) — STALE: working tree changed",
        `overview: ${"x".repeat(100)}…`,
        "coverage: 1/1 assigned, 0 unassigned",
        "  [0/1] Leftovers (auto) — orphans",
        "unreviewed (1):",
        "  a — a.ts",
      ].join("\n"),
    );
  });

  it("summarizes a fresh, fully reviewed session in three lines", async () => {
    const node = {
      id: "n1",
      stableId: "fn:a",
      label: "a",
      file: "a.ts",
      changeStatus: "changed",
      reviewStatus: "reviewed-clean",
    };
    const bodies: Record<string, unknown> = {
      "/api/sessions/s1": {
        session: { id: "s1", status: "complete", overview: "Short overview" },
        units: [{ id: "u1", label: "Orders", kind: "orphans", memberStableIds: ["fn:a"], auto: false, attached: [] }],
        coverage: { changedTotal: 1, covered: 1, unassigned: 0 },
        stale: false,
      },
      "/api/sessions/s1/nodes": { nodes: [node] },
      "/api/sessions/s1/flows": { flows: [], orphans: [] },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => bodies[new URL(url).pathname] })),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCli(["status", "--session", "s1", "--pretty"]);
    expect(log.mock.calls[0]![0]).toBe(
      [
        "session s1 (complete)",
        "overview: Short overview",
        "coverage: 1/1 assigned, 0 unassigned",
        "  [1/1] Orders — orphans",
      ].join("\n"),
    );
  });
});
