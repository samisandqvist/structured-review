// Comparing a review's head with the base map: crossings that appear,
// disappear or change, new surfaces, touched contracts, changed components
// and files the base model cannot place.
import { describe, it, expect } from "vitest";
import { checkMap } from "../src/map/check.js";
import { compareVersions, type ChangeInput } from "../src/map/change.js";
import type { ReferenceIndex, SymbolDef } from "../src/graph/references.js";

const S = (file: string, name: string) => `scip-typescript npm fx 1.0 ${file.replace(/([^/]+)$/, "`$1`")}/${name}().`;

type Def = [file: string, name: string, line: number];
type Ref = [file: string, target: string, caller: string, line: number];
const DEFS: Def[] = [
  ["src/store/jobs.ts", "getJob", 1],
  ["src/store/jobs.ts", "saveJob", 5],
  ["src/api/handler.ts", "handle", 3],
  ["src/core/run.ts", "run", 2],
  ["src/core/run.ts", "tick", 8],
];
const BASE_REFS: Ref[] = [
  ["src/api/handler.ts", "src/store/jobs.ts:getJob", "handle", 4],
  ["src/api/handler.ts", "src/core/run.ts:run", "handle", 5],
  ["src/core/run.ts", "src/store/jobs.ts:getJob", "run", 3],
  ["src/core/run.ts", "src/store/jobs.ts:saveJob", "run", 4],
];

function index(refs: Ref[], defs: Def[] = DEFS): ReferenceIndex {
  const definitions = new Map<string, SymbolDef>();
  for (const [file, name, line] of defs) definitions.set(S(file, name), { symbol: S(file, name), file, line, name, kind: "function" });
  const symbolOf = (target: string) => {
    const [file, name] = target.split(":");
    return S(file!, name!);
  };
  return {
    files: [...new Set(defs.map((d) => d[0]))].sort(),
    definitions,
    references: refs.map(([file, target, caller, line]) => ({ file, symbol: symbolOf(target), caller, line, typeOnly: false })),
    implementations: new Map(),
    barrels: [],
    gaps: [],
  };
}

const MODEL = {
  title: "Fixture",
  components: [
    { id: "app", name: "App", parent: null, paths: ["src/"], meaning: "root" },
    { id: "feeds", name: "Feeds", parent: null, external: true, meaning: "upstream" },
    { id: "store", name: "Store", parent: "app", paths: ["src/store/"], meaning: "persistence" },
    { id: "api", name: "API", parent: "app", paths: ["src/api/"], meaning: "operator API" },
    { id: "core", name: "Core", parent: "app", paths: ["src/core/"], meaning: "engine" },
  ],
  interfaces: [
    { id: "reads", name: "Reads", provider: "store", requirers: ["api", "core"], meaning: "reads", bind: ["getJob"] },
    { id: "writes", name: "Writes", provider: "store", requirers: ["core"], meaning: "writes", bind: ["saveJob"] },
    { id: "runs", name: "Runs", provider: "core", requirers: ["api"], meaning: "runs", bind: ["run"] },
    {
      id: "hook",
      name: "Hook",
      provider: "app",
      requirers: ["feeds"],
      kind: "webhook",
      meaning: "POST /hook",
      evidence: ["src/api/handler.ts"],
    },
  ],
  undeclared: [],
};

const checked = checkMap(MODEL, index(BASE_REFS), () => true);

function compare(over: Partial<Omit<ChangeInput, "model" | "base">> = {}) {
  return compareVersions(
    {
      model: checked.model,
      base: checked.map,
      head: index(BASE_REFS),
      nodes: [],
      files: [],
      changedLines: () => [],
      ...over,
    },
    "abc123",
  );
}

describe("compareVersions", () => {
  it("starts from a base map that passes the check", () => {
    expect(checked.map.report.ok).toBe(true);
    expect(compare()).toEqual({
      baseSha: "abc123",
      components: [],
      nodeComponents: {},
      crossings: [],
      surfaces: [],
      delegations: [],
      touched: [],
      unmapped: [],
    });
  });

  it("marks a crossing the head adds as new", () => {
    const change = compare({ head: index([...BASE_REFS, ["src/api/handler.ts", "src/store/jobs.ts:saveJob", "handle", 6]]) });
    expect(change.crossings).toEqual([
      {
        interface: "writes",
        requirer: "api",
        status: "new",
        added: [expect.objectContaining({ file: "src/api/handler.ts", line: 6, caller: "handle", symbol: "saveJob" })],
        removed: [],
      },
    ]);
  });

  it("marks a crossing the head drops as removed", () => {
    const change = compare({ head: index(BASE_REFS.filter((r) => r[1] !== "src/core/run.ts:run")) });
    expect(change.crossings).toEqual([
      expect.objectContaining({ interface: "runs", requirer: "api", status: "removed", added: [], removed: [expect.objectContaining({ line: 5 })] }),
    ]);
  });

  it("marks a crossing with a new caller as changed", () => {
    const change = compare({ head: index([...BASE_REFS, ["src/core/run.ts", "src/store/jobs.ts:getJob", "tick", 9]]) });
    expect(change.crossings).toEqual([
      expect.objectContaining({ interface: "reads", requirer: "core", status: "changed", added: [expect.objectContaining({ caller: "tick" })], removed: [] }),
    ]);
  });

  it("does not mark a call that only moved within its file", () => {
    const moved = BASE_REFS.map((r): Ref => (r[2] === "handle" && r[3] === 4 ? [r[0], r[1], r[2], 8] : r));
    expect(compare({ head: index(moved) }).crossings).toEqual([]);
  });

  it("reports a renamed bound symbol as a lost binding and its uses as a new surface", () => {
    const defs = DEFS.map((d): Def => (d[1] === "getJob" ? [d[0], "fetchJob", d[2]] : d));
    const refs = BASE_REFS.map((r): Ref => (r[1].endsWith(":getJob") ? [r[0], "src/store/jobs.ts:fetchJob", r[2], r[3]] : r));
    const change = compare({ head: index(refs, defs) });
    expect(change.touched).toEqual([{ interface: "reads", reasons: ["binding-lost"], symbols: ["getJob"] }]);
    expect(change.surfaces).toEqual([
      {
        id: "new:store:src/store/jobs.ts:fetchJob",
        provider: "store",
        requirers: ["api", "core"],
        symbol: "fetchJob",
        file: "src/store/jobs.ts",
        line: 1,
        references: 2,
        where: ["src/api/handler.ts:4 (handle)", "src/core/run.ts:3 (run)"],
        sites: [
          expect.objectContaining({ file: "src/api/handler.ts", requirer: "api" }),
          expect.objectContaining({ file: "src/core/run.ts", requirer: "core" }),
        ],
      },
    ]);
    expect(change.crossings.map((c) => [c.interface, c.requirer, c.status])).toEqual([
      ["reads", "api", "removed"],
      ["reads", "core", "removed"],
    ]);
  });

  it("marks a contract touched when a bound function's body or line changed", () => {
    const change = compare({
      nodes: [{ id: "n1", file: "src/store/jobs.ts", startLine: 5, endLine: 7, isTest: false, residual: false, changed: true }],
      changedLines: (file) => (file === "src/store/jobs.ts" ? [{ start: 1, end: 1 }] : []),
    });
    expect(change.touched).toEqual([
      { interface: "reads", reasons: ["body"], symbols: ["getJob"] },
      { interface: "writes", reasons: ["body"], symbols: ["saveJob"] },
    ]);
  });

  it("does not take a residual's span for a function body", () => {
    const change = compare({
      nodes: [{ id: "r1", file: "src/store/jobs.ts", startLine: 1, endLine: 9, isTest: false, residual: true, changed: true }],
    });
    expect(change.touched).toEqual([]);
  });

  it("marks a cross-process contract touched when an evidence file changed", () => {
    const change = compare({ files: [{ path: "src/api/handler.ts", status: "modified" }] });
    expect(change.touched).toEqual([{ interface: "hook", reasons: ["evidence"], symbols: [] }]);
  });

  it("counts changed items on their component and its ancestors", () => {
    const change = compare({
      nodes: [
        { id: "n1", file: "src/core/run.ts", startLine: 8, endLine: 9, isTest: false, residual: false, changed: true },
        { id: "n2", file: "src/core/run.ts", startLine: 2, endLine: 6, isTest: false, residual: false, changed: false },
        { id: "t1", file: "test/run.test.ts", startLine: 1, endLine: 4, isTest: true, residual: false, changed: true },
      ],
      files: [
        { path: "src/core/run.ts", status: "modified" },
        { path: "test/run.test.ts", status: "modified" },
      ],
    });
    expect(change.nodeComponents).toEqual({ n1: "core", t1: null });
    expect(change.components).toEqual([
      { id: "app", items: 1, files: 1 },
      { id: "core", items: 1, files: 1 },
    ]);
  });

  it("lists changed files the base model cannot place and marks owners of deleted files", () => {
    const change = compare({
      files: [
        { path: "src/new.ts", status: "added" },
        { path: "scripts/tool.ts", status: "added" },
        { path: "src/core/old.ts", status: "deleted" },
        { path: "src/core/moved.ts", status: "renamed", oldPath: "src/store/moved.ts" },
      ],
    });
    expect(change.unmapped).toEqual([
      { component: "app", files: ["src/new.ts"] },
      { component: null, files: ["scripts/tool.ts"] },
    ]);
    expect(change.components).toEqual([
      { id: "app", items: 0, files: 4 },
      { id: "core", items: 0, files: 2 },
      { id: "store", items: 0, files: 1 },
    ]);
  });
});

describe("compareVersions delegations", () => {
  const nested = {
    ...MODEL,
    components: [
      ...MODEL.components,
      { id: "engine", name: "Engine", parent: "core", paths: ["src/core/run.ts"], meaning: "runs" },
      { id: "clock", name: "Clock", parent: "core", paths: ["src/core/clock.ts"], meaning: "ticks" },
      { id: "repo", name: "Repo", parent: "store", paths: ["src/store/jobs.ts"], meaning: "rows" },
      { id: "cache", name: "Cache", parent: "store", paths: ["src/store/cache.ts"], meaning: "memo" },
    ],
  };
  const defs: Def[] = [...DEFS, ["src/core/clock.ts", "tock", 1], ["src/store/cache.ts", "warm", 1]];
  const base = checkMap(nested, index(BASE_REFS, defs), () => true);

  it("derives where new crossings and new surfaces enter and leave nested parts", () => {
    const head = index(
      [
        ...BASE_REFS,
        ["src/core/clock.ts", "src/store/jobs.ts:getJob", "tock", 2],
        ["src/core/clock.ts", "src/store/jobs.ts:saveJob", "tock", 3],
        ["src/api/handler.ts", "src/store/cache.ts:warm", "handle", 7],
      ],
      defs,
    );
    expect(base.map.report.ok).toBe(true);
    const change = compareVersions(
      { model: base.model, base: base.map, head, nodes: [], files: [], changedLines: () => [] },
      "abc123",
    );
    expect(change.surfaces).toEqual([
      expect.objectContaining({
        id: "new:store:src/store/cache.ts:warm",
        sites: [expect.objectContaining({ file: "src/api/handler.ts", line: 7, requirer: "api", component: "api" })],
      }),
    ]);
    expect(change.delegations).toEqual([
      { interface: "reads", side: "required", outer: "core", inner: "clock" },
      { interface: "writes", side: "required", outer: "core", inner: "clock" },
      { interface: "new:store:src/store/cache.ts:warm", side: "provided", outer: "store", inner: "cache" },
    ]);
  });
});
