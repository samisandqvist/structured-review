// Resolving a component model against a reference index and evaluating the
// fidelity rules. The fixture index is written as a small table of
// definitions and references.
import { describe, it, expect } from "vitest";
import { checkMap } from "../src/map/check.js";
import type { ReferenceIndex, SymbolDef, SymbolKind } from "../src/graph/references.js";

const S = (file: string, name: string, kind: SymbolKind = "function") => {
  const suffix = kind === "type" ? "#" : kind === "value" ? "." : "().";
  return `scip-typescript npm fx 1.0 ${file.replace(/([^/]+)$/, "`$1`")}/${name}${suffix}`;
};
const DEFS: [string, string, SymbolKind, number][] = [
  ["src/store/jobs.ts", "getJob", "function", 1],
  ["src/store/jobs.ts", "saveJob", "function", 5],
  ["src/store/jobs.ts", "Job", "type", 9],
  ["src/store/legacy.ts", "getJob", "function", 1],
  ["src/api/handler.ts", "handle", "function", 3],
  ["src/core/engine/run.ts", "run", "function", 2],
  ["src/core/engine/wake.ts", "wake", "function", 2],
  ["src/core/support.ts", "helper", "function", 1],
  ["src/lib/log.ts", "log", "function", 1],
  ["src/lib/log.ts", "LEVEL", "value", 9],
  ["src/main.ts", "main", "function", 1],
];
const GET_JOB = S("src/store/jobs.ts", "getJob");
const SAVE_JOB = S("src/store/jobs.ts", "saveJob");
const JOB = S("src/store/jobs.ts", "Job", "type");
const HANDLE = S("src/api/handler.ts", "handle");
const RUN = S("src/core/engine/run.ts", "run");
const HELPER = S("src/core/support.ts", "helper");
const LOG = S("src/lib/log.ts", "log");

type Ref = [file: string, symbol: string, caller: string, line: number, typeOnly?: boolean];
const REFS: Ref[] = [
  ["src/api/handler.ts", GET_JOB, "handle", 4],
  ["src/api/handler.ts", SAVE_JOB, "handle", 5],
  ["src/api/handler.ts", JOB, "handle", 3, true],
  ["src/core/engine/run.ts", SAVE_JOB, "run", 3],
  ["src/core/engine/run.ts", GET_JOB, "run", 4],
  ["src/core/engine/run.ts", HELPER, "run", 5],
  ["src/core/engine/wake.ts", RUN, "wake", 3],
  ["src/api/handler.ts", LOG, "handle", 6],
  ["src/core/engine/run.ts", LOG, "run", 6],
  ["src/main.ts", HANDLE, "main", 2],
];

function index(refs: Ref[] = REFS, defs = DEFS): ReferenceIndex {
  const definitions = new Map<string, SymbolDef>();
  for (const [file, name, kind, line] of defs) {
    const symbol = S(file, name, kind);
    definitions.set(symbol, { symbol, file, line, name, kind });
  }
  return {
    files: [...new Set(defs.map((d) => d[0]))].sort(),
    definitions,
    references: refs.map(([file, symbol, caller, line, typeOnly]) => ({
      file,
      symbol,
      caller,
      line,
      typeOnly: typeOnly ?? false,
    })),
    implementations: new Map(),
    barrels: [],
    gaps: ["cs root 'dotnet' is not yet mapped; its code is missing from the component map"],
  };
}

function model() {
  return {
    title: "Fixture",
    components: [
      { id: "app", name: "App", parent: null, paths: [""], meaning: "root" },
      { id: "feeds", name: "Feeds", parent: null, external: true, meaning: "upstream" },
      { id: "store", name: "Store", parent: "app", paths: ["src/store/jobs.ts"], meaning: "persistence" },
      { id: "api", name: "API", parent: "app", paths: ["src/api/"], meaning: "operator API" },
      { id: "core", name: "Core", parent: "app", paths: ["src/core/"], meaning: "engine" },
      { id: "engine", name: "Engine", parent: "core", paths: ["src/core/engine/"], meaning: "runs" },
      { id: "support", name: "Support", parent: "core", paths: ["src/core/support.ts"], meaning: "helpers" },
      { id: "infra", name: "Infra", parent: "app", paths: ["src/lib/"], utility: true, meaning: "helpers" },
    ],
    interfaces: [
      { id: "reads", name: "Reads", provider: "store", requirers: ["api", "core"], meaning: "r", bind: ["getJob"] },
      { id: "writes", name: "Writes", provider: "store", requirers: ["core"], meaning: "w", bind: ["saveJob"] },
      { id: "help", name: "Help", provider: "support", requirers: ["engine"], meaning: "h", bind: ["helper"] },
      {
        id: "feed-hook",
        name: "Feed hook",
        provider: "app",
        requirers: ["feeds"],
        meaning: "webhook",
        kind: "webhook",
        evidence: ["src/api/handler.ts"],
      },
    ],
    undeclared: [{ interface: "writes", requirer: "api", reason: "the core header claims all writes" }],
  };
}
type Model = ReturnType<typeof model>;
const exists = (f: string) => !f.includes("missing");
const run = (mutate: (m: Model) => void = () => {}, idx = index()) => {
  const m = model();
  mutate(m);
  return checkMap(m, idx, exists).map;
};
const messages = (mutate: (m: Model) => void, idx?: ReferenceIndex) =>
  run(mutate, idx).report.issues.map((i) => `${i.rule}: ${i.message}`);

describe("checkMap on a clean model", () => {
  const map = run();
  const iface = (id: string) => map.interfaces.find((i) => i.id === id)!;

  it("returns ok with full coverage", () => {
    expect(map.report.issues).toEqual([]);
    expect(map.report.ok).toBe(true);
    expect(map.report.coverage).toEqual({ references: 5, covered: 5, undeclared: 1 });
  });

  it("resolves bindings to file, line and owning component", () => {
    expect(iface("reads").bindings).toEqual([
      { symbol: GET_JOB, name: "getJob", file: "src/store/jobs.ts", line: 1, component: "store" },
    ]);
  });

  it("records call sites with caller, requirer and undeclared flag", () => {
    expect(iface("writes").sites).toEqual([
      {
        file: "src/api/handler.ts",
        line: 5,
        caller: "handle",
        symbol: "saveJob",
        component: "api",
        requirer: "api",
        undeclared: true,
      },
      {
        file: "src/core/engine/run.ts",
        line: 3,
        caller: "run",
        symbol: "saveJob",
        component: "engine",
        requirer: "core",
        undeclared: false,
      },
    ]);
    expect(iface("writes").reasons).toEqual([{ requirer: "api", reason: "the core header claims all writes" }]);
  });

  it("derives provided and required delegation", () => {
    expect(map.delegations).toEqual(
      expect.arrayContaining([
        { interface: "reads", side: "required", outer: "core", inner: "engine" },
        { interface: "writes", side: "required", outer: "core", inner: "engine" },
        { interface: "feed-hook", side: "provided", outer: "app", inner: "api" },
      ]),
    );
    expect(map.delegations).toHaveLength(3);
  });

  it("resolves cross-process evidence files to components", () => {
    expect(iface("feed-hook").evidenceFiles).toEqual([{ file: "src/api/handler.ts", component: "api" }]);
  });

  it("exempts references into a utility and counts them", () => {
    expect(map.report.utilities).toEqual([{ id: "infra", references: 2 }]);
  });

  it("counts a reference from an unclaimed parent file as unattributed and lists the file", () => {
    expect(map.report.unattributedReferences).toBe(1);
    expect(map.report.unclaimedFiles).toEqual([{ component: "app", files: ["src/main.ts", "src/store/legacy.ts"] }]);
  });

  it("reports type-only dependencies separately", () => {
    expect(map.report.typeDependencies).toEqual([{ from: "api", to: "store", count: 1, symbols: ["Job"] }]);
  });

  it("counts files per component subtree and carries gaps", () => {
    expect(map.components.find((c) => c.id === "core")!.fileCount).toBe(3);
    expect(map.components.find((c) => c.id === "app")!.fileCount).toBe(8);
    expect(map.report.gaps).toHaveLength(1);
  });
});

describe("checkMap fidelity rules", () => {
  it("rule 1: reports uncovered references grouped by provider symbol", () => {
    const report = run((m) => (m.interfaces[0]!.bind = ["Job"])).report;
    const issue = report.issues.find((i) => i.rule === "coverage")!;
    expect(issue.message).toBe(
      "'store' symbol 'getJob' (src/store/jobs.ts:1) is used by api, core but bound by no interface of 'store' (2 references)",
    );
    expect(issue.where).toEqual(["src/api/handler.ts:4 (handle)", "src/core/engine/run.ts:4 (run)"]);
    expect(report.coverage).toEqual({ references: 5, covered: 3, undeclared: 1 });
    expect(report.ok).toBe(false);
  });

  it("rule 2: reports an unbound entry", () => {
    expect(messages((m) => m.interfaces[0]!.bind.push("nothing"))).toContain(
      "binding: bind entry 'nothing' of interface 'reads' matches no symbol in 'store'",
    );
  });

  it("rule 2: reports an ambiguous entry and accepts the qualified form", () => {
    const widen = (m: Model) => (m.components[2]!.paths = ["src/store/"]);
    expect(messages(widen)).toContain(
      "binding: bind entry 'getJob' of interface 'reads' matches symbols in src/store/jobs.ts, src/store/legacy.ts; qualify it as 'src/store/jobs.ts:getJob'",
    );
    const qualified = run((m) => {
      widen(m);
      m.interfaces[0]!.bind = ["src/store/jobs.ts:getJob"];
    });
    expect(qualified.report.issues).toEqual([]);
  });

  it("rule 2: reports a symbol bound twice by one provider", () => {
    expect(messages((m) => m.interfaces[1]!.bind.push("getJob"))).toContain(
      "binding: symbol 'getJob' of 'store' is bound by both 'reads' and 'writes'",
    );
  });

  it("binds a type and its members with Type#*", () => {
    const idx = index(
      [...REFS, ["src/api/handler.ts", S("src/store/jobs.ts", "Job#find", "function"), "handle", 7]],
      [...DEFS, ["src/store/jobs.ts", "Job#find", "function", 10]],
    );
    const map = run((m) => m.interfaces[0]!.bind.push("Job#*"), idx);
    expect(map.interfaces[0]!.bindings.map((b) => b.name)).toEqual(["getJob", "Job", "Job#find"]);
    expect(map.report.issues).toEqual([]);
  });
});

describe("checkMap requirer, undeclared, evidence and utility rules", () => {
  it("rule 3: reports a declared requirer without call sites", () => {
    expect(messages((m) => m.interfaces[2]!.requirers.push("other"))).toContain(
      "model: interface 'help' has unknown requirer 'other'",
    );
    const m2 = messages((m) => {
      m.components.push({ id: "idle", name: "Idle", parent: "core", paths: ["src/core/idle/"], meaning: "" });
      m.interfaces[2]!.requirers.push("idle");
    });
    expect(m2).toContain("requirer: declared requirer 'idle' of interface 'help' has no call sites");
  });

  it("rule 4: reports an undeclared use without an entry and a stale entry", () => {
    const missing = run((m) => (m.undeclared = []));
    expect(missing.report.issues.map((i) => i.message)).toEqual([
      "interface 'writes' of 'store' is used by undeclared requirer 'api' (1 call site); declare the requirer or add an undeclared entry with a reason",
    ]);
    expect(messages((m) => m.interfaces[1]!.requirers.push("api"))).toContain(
      "undeclared: undeclared entry for 'writes' by 'api' has no undeclared call sites",
    );
  });

  it("rule 5: reports missing, nonexistent and misplaced evidence", () => {
    expect(messages((m) => (m.interfaces[3]!.evidence = []))).toContain(
      "evidence: cross-process interface 'feed-hook' needs evidence files",
    );
    expect(messages((m) => (m.interfaces[3]!.evidence = ["src/api/missing.ts"]))).toContain(
      "evidence: evidence file 'src/api/missing.ts' of interface 'feed-hook' does not exist",
    );
    const misplaced = messages((m) => {
      m.interfaces[3] = { ...m.interfaces[3]!, provider: "store", requirers: ["api"], evidence: ["src/core/x.ts"] };
    });
    expect(misplaced).toContain(
      "evidence: evidence file 'src/core/x.ts' of interface 'feed-hook' is outside the components it connects",
    );
  });

  it("reports a utility that calls a visible component", () => {
    const idx = index([...REFS, ["src/lib/log.ts", GET_JOB, "log", 3], ["src/lib/log.ts", JOB, "log", 2, true]]);
    expect(messages(() => {}, idx)).toEqual([
      "utility: utility 'infra' references visible component 'store' (1 reference); utilities may not depend on visible components",
    ]);
  });

  it("reports model issues without resolving", () => {
    const map = run((m) => (m.components[2]!.parent = "nowhere"));
    expect(map.report.ok).toBe(false);
    expect(map.report.issues.every((i) => i.rule === "model")).toBe(true);
    expect(map.interfaces).toEqual([]);
    expect(map.report.gaps).toHaveLength(1);
  });

  it("maps across root components through the system level", () => {
    const map = run((m) => {
      m.components = m.components.map((c) => (c.id === "api" ? { ...c, parent: null } : c));
      m.interfaces = [
        { ...m.interfaces[0]!, requirers: ["core"] },
        m.interfaces[1]!,
        m.interfaces[2]!,
        {
          id: "app-api",
          name: "App API",
          provider: "app",
          requirers: ["api"],
          meaning: "",
          bind: ["src/store/jobs.ts:getJob", "saveJob"],
        },
        { id: "handling", name: "Handling", provider: "api", requirers: ["app"], meaning: "", bind: ["handle"] },
      ];
      m.undeclared = [];
    });
    expect(map.report.issues).toEqual([]);
    const appApi = map.interfaces.find((i) => i.id === "app-api")!;
    expect(appApi.sites.map((s) => s.requirer)).toEqual(["api", "api"]);
    expect(map.delegations).toContainEqual({ interface: "app-api", side: "provided", outer: "app", inner: "store" });
    expect(map.report.unattributedReferences).toBe(0);
  });
});

describe("checkMap edge cases", () => {
  const many = (n: number, file: string, symbol: string, typeOnly = false): Ref[] =>
    Array.from({ length: n }, (_, k) => [file, symbol, "handle", 20 + k, typeOnly] as Ref);

  it("caps samples at five and says reference for a single one", () => {
    const idx = index([...REFS, ...many(6, "src/api/handler.ts", HELPER)]);
    const issue = run(() => {}, idx).report.issues.find((i) => i.rule === "coverage")!;
    expect(issue.where).toHaveLength(5);
    expect(issue.message).toContain("(6 references)");
    const single = run(() => {}, index([...REFS, ["src/api/handler.ts", HELPER, "handle", 9]])).report.issues;
    expect(single.find((i) => i.rule === "coverage")!.message).toContain("(1 reference)");
  });

  it("caps type dependency symbols at eight", () => {
    const names = Array.from({ length: 9 }, (_, k) => `T${k}`);
    const defs = [...DEFS, ...names.map((n, k) => ["src/store/jobs.ts", n, "type", 30 + k] as (typeof DEFS)[number])];
    const refs = [
      ...REFS,
      ...names.map((n) => ["src/api/handler.ts", S("src/store/jobs.ts", n, "type"), "handle", 3, true] as Ref),
    ];
    const deps = run(() => {}, index(refs, defs)).report.typeDependencies;
    expect(deps[0]).toMatchObject({ from: "api", to: "store", count: 10 });
    expect(deps[0]!.symbols).toHaveLength(8);
  });

  it("ignores type-only references from a parent's own files", () => {
    const deps = run(() => {}, index([...REFS, ["src/main.ts", JOB, "main", 1, true]])).report.typeDependencies;
    expect(deps).toEqual([{ from: "api", to: "store", count: 1, symbols: ["Job"] }]);
  });

  it("names the utility's target when it references its parent's own files", () => {
    const idx = index([...REFS, ["src/lib/log.ts", S("src/main.ts", "main"), "log", 4]]);
    expect(messages(() => {}, idx)).toContain(
      "utility: utility 'infra' references visible component 'app' (1 reference); utilities may not depend on visible components",
    );
  });

  it("counts plural undeclared call sites", () => {
    const idx = index([...REFS, ["src/api/handler.ts", SAVE_JOB, "handle", 8]]);
    expect(messages((m) => (m.undeclared = []), idx)).toContain(
      "undeclared: interface 'writes' of 'store' is used by undeclared requirer 'api' (2 call sites); declare the requirer or add an undeclared entry with a reason",
    );
  });

  it("delegates requirer-side evidence to the requiring part", () => {
    const map = run((m) => {
      m.interfaces[3] = {
        ...m.interfaces[3]!,
        provider: "feeds",
        requirers: ["app"],
        evidence: ["src/core/engine/run.ts"],
      };
    });
    expect(map.report.issues).toEqual([]);
    expect(map.delegations).toEqual(
      expect.arrayContaining([
        { interface: "feed-hook", side: "required", outer: "app", inner: "core" },
        { interface: "feed-hook", side: "required", outer: "core", inner: "engine" },
      ]),
    );
  });

  it("lists files no component claims and leaves them out of counts", () => {
    const map = run((m) => (m.components[0]!.paths = ["src/core/"]));
    expect(map.report.unclaimedFiles).toContainEqual({
      component: null,
      files: ["src/main.ts", "src/store/legacy.ts"],
    });
    expect(map.components.find((c) => c.id === "app")!.fileCount).toBe(6);
  });
});

describe("checkMap unclaimed files outside the mapped tree", () => {
  it("lists only unowned files under the top-level directories the model claims", () => {
    const idx = index(REFS, [
      ...DEFS,
      ["other/service/x.ts", "x", "function", 1],
      ["src/stray.ts", "stray", "function", 1],
    ]);
    const map = run((m) => {
      m.components[0]!.paths = ["src/api/", "src/core/", "src/store/", "src/lib/", "src/main.ts"];
    }, idx);
    expect(map.report.unclaimedFiles).toContainEqual({ component: null, files: ["src/stray.ts"] });
  });
});
