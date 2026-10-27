// Evidence the LLM reasons from when it writes a component model.
import { describe, it, expect } from "vitest";
import { buildEvidence } from "../src/map/evidence.js";
import type { ReferenceIndex, SymbolDef } from "../src/graph/references.js";
import type { ComponentMap } from "../src/component-map.js";

const sym = (file: string, desc: string) => `scip-typescript npm fx 1.0 ${file.replace(/([^/]+)$/, "`$1`")}/${desc}`;
const def = (file: string, name: string, line: number, kind: SymbolDef["kind"] = "function"): SymbolDef => ({
  symbol: sym(file, kind === "type" ? `${name}#` : `${name}().`),
  file,
  line,
  name,
  kind,
});
const DEFS = [
  def("src/store/jobs.ts", "getJob", 1),
  def("src/store/jobs.ts", "saveJob", 5),
  def("src/store/jobs.ts", "Store", 9, "type"),
  def("src/store/memory.ts", "MemoryStore", 1, "type"),
  def("src/api/handler.ts", "handle", 3),
  def("src/core/run.ts", "run", 2),
  def("src/config.ts", "load", 1),
  ...Array.from({ length: 14 }, (_, k) => def("src/store/extra.ts", `extra${k}`, k + 1)),
];
const by = (name: string) => DEFS.find((d) => d.name === name)!;
const ref = (file: string, name: string, typeOnly = false) => ({
  symbol: by(name).symbol,
  file,
  line: 1,
  caller: "x",
  typeOnly,
});

const index: ReferenceIndex = {
  files: [
    "src/api/handler.ts",
    "src/config.ts",
    "src/core/run.ts",
    "src/store/extra.ts",
    "src/store/index.ts",
    "src/store/jobs.ts",
    "src/store/memory.ts",
  ],
  definitions: new Map(DEFS.map((d) => [d.symbol, d])),
  references: [
    ref("src/api/handler.ts", "getJob"),
    ref("src/core/run.ts", "getJob"),
    ref("src/core/run.ts", "saveJob"),
    ref("src/core/run.ts", "load"),
    ref("src/api/handler.ts", "load"),
    ref("src/api/handler.ts", "Store", true),
    ...Array.from({ length: 14 }, (_, k) => ref("src/core/run.ts", `extra${k}`)),
  ],
  implementations: new Map([[by("Store").symbol, [by("MemoryStore").symbol]]]),
  barrels: [{ file: "src/store/index.ts", exports: [{ from: "src/store/jobs.ts", names: ["getJob"] }] }],
  gaps: ["a gap"],
};
const sources: Record<string, string> = {
  "src/store/jobs.ts": `// Persistence facade.\n// ${"x".repeat(300)}\nexport function getJob() {}\n`,
  "src/api/handler.ts": 'app.post("/hooks/feed", handle);\n',
  "src/core/run.ts": "export function run() {}\n",
  "package.json": JSON.stringify({ bin: { fx: "./dist/cli.js" }, main: "dist/index.js" }),
};
const ctx = { readSource: (f: string) => sources[f], roots: [{ language: "ts", root: "" }] };

describe("buildEvidence", () => {
  const brief = buildEvidence(index, ctx, { full: false });

  it("scopes to the common source directory and lists candidates", () => {
    expect(brief.scope).toBe("src");
    expect(brief.candidates).toEqual([
      { id: "src/api/", files: 1 },
      { id: "src/config.ts", files: 1 },
      { id: "src/core/", files: 1 },
      { id: "src/store/", files: 4 },
    ]);
    expect(brief.tree).toEqual([
      { path: "src", files: 7 },
      { path: "src/api", files: 1 },
      { path: "src/core", files: 1 },
      { path: "src/store", files: 4 },
    ]);
  });

  it("counts value references between candidates", () => {
    expect(brief.matrix).toEqual([
      { from: "src/core/", to: "src/store/", references: 16 },
      { from: "src/api/", to: "src/config.ts", references: 1 },
      { from: "src/api/", to: "src/store/", references: 1 },
      { from: "src/core/", to: "src/config.ts", references: 1 },
    ]);
  });

  it("groups boundary symbols by the components that use them, capped in brief mode", () => {
    const store = brief.surfaces.find((s) => s.candidate === "src/store/")!;
    expect(store.symbols).toBe(16);
    expect(store.groups[0]).toEqual({
      usedBy: ["src/core/"],
      symbols: [...Array.from({ length: 12 }, () => expect.stringMatching(/^extra|^saveJob/)), "+3 more"],
    });
    expect(store.groups[1]).toEqual({ usedBy: ["src/api/", "src/core/"], symbols: ["getJob (src/store/jobs.ts:1)"] });
  });

  it("collects explicit signals", () => {
    expect(brief.signals.implementations).toEqual([
      { type: "Store", file: "src/store/jobs.ts", implementations: ["MemoryStore (src/store/memory.ts)"] },
    ]);
    expect(brief.signals.barrels).toHaveLength(1);
    expect(brief.signals.headers[0]!.file).toBe("src/store/jobs.ts");
    expect(brief.signals.headers[0]!.comment).toHaveLength(160);
    expect(brief.signals.registrations).toEqual([
      { file: "src/api/handler.ts", line: 1, text: 'app.post("/hooks/feed", handle);' },
    ]);
    expect(brief.signals.entryPoints).toEqual([
      { file: "package.json", reason: "bin: ./dist/cli.js" },
      { file: "package.json", reason: "main: dist/index.js" },
    ]);
    expect(brief.gaps).toEqual(["a gap"]);
    expect(brief.roots).toEqual([{ language: "ts", root: "" }]);
  });
});

describe("buildEvidence modes", () => {
  it("shows everything in full mode", () => {
    const full = buildEvidence(index, ctx, { full: true });
    const store = full.surfaces.find((s) => s.candidate === "src/store/")!;
    expect(store.groups[0]!.symbols).toHaveLength(15);
    expect(full.signals.headers[0]!.comment.length).toBeGreaterThan(160);
  });

  it("narrows to a sub-tree and labels outside consumers", () => {
    const within = buildEvidence(index, ctx, { within: "./src/store/", full: false });
    expect(within.scope).toBe("src/store");
    expect(within.candidates.map((c) => c.id)).toEqual([
      "src/store/extra.ts",
      "src/store/index.ts",
      "src/store/jobs.ts",
      "src/store/memory.ts",
    ]);
    expect(within.matrix).toContainEqual({ from: "(outside)", to: "src/store/jobs.ts", references: 3 });
    expect(within.surfaces.find((s) => s.candidate === "src/store/jobs.ts")!.groups[0]!.usedBy).toEqual(["(outside)"]);
  });

  it("includes manifest components when the repository has a manifest", () => {
    const manifest: ComponentMap = {
      source: "manifest",
      warnings: [],
      components: [
        { id: "store", description: "db", paths: ["src/store/**"], criticality: "high", contracts: [], consumers: [] },
      ],
    };
    expect(buildEvidence(index, { ...ctx, manifest }, { full: false }).manifest).toEqual([
      { id: "store", description: "db", paths: ["src/store/**"] },
    ]);
    const inferred: ComponentMap = { ...manifest, source: "inferred" };
    expect(buildEvidence(index, { ...ctx, manifest: inferred }, { full: false }).manifest).toBeUndefined();
  });

  it("lists package entry points for the nearest enclosing package and packages inside the scope", () => {
    const nestedSources: Record<string, string> = {
      ...sources,
      "src/store/package.json": JSON.stringify({ main: "index.js" }),
      "lib/package.json": JSON.stringify({ main: "lib.js" }),
    };
    const nested = {
      readSource: (f: string) => nestedSources[f],
      roots: [
        { language: "ts", root: "" },
        { language: "ts", root: "src/store" },
        { language: "ts", root: "lib" },
      ],
    };
    expect(buildEvidence(index, nested, { within: "src", full: false }).signals.entryPoints).toEqual([
      { file: "package.json", reason: "bin: ./dist/cli.js" },
      { file: "package.json", reason: "main: dist/index.js" },
      { file: "src/store/package.json", reason: "main: index.js" },
    ]);
    expect(buildEvidence(index, nested, { within: "src/store", full: false }).signals.entryPoints).toEqual([
      { file: "src/store/package.json", reason: "main: index.js" },
    ]);
  });

  it("ignores an unreadable package.json and a missing one", () => {
    const broken = { ...ctx, readSource: (f: string) => (f === "package.json" ? "{" : sources[f]) };
    expect(buildEvidence(index, broken, { full: false }).signals.entryPoints).toEqual([]);
    const nested = {
      ...ctx,
      roots: [
        { language: "ts", root: "web" },
        { language: "py", root: "" },
      ],
    };
    expect(buildEvidence(index, nested, { full: false }).signals.entryPoints).toEqual([]);
  });

  it("handles an empty index", () => {
    const empty = buildEvidence({ ...index, files: [], references: [], definitions: new Map() }, ctx, { full: false });
    expect(empty.scope).toBe("");
    expect(empty.candidates).toEqual([]);
  });
});

describe("buildEvidence across layouts", () => {
  const files = ["main.py", "app/deep/er/still/x.py", "app/deep/y.py", "tools/z.py"];
  const d = (file: string, name: string, kind: SymbolDef["kind"] = "function"): SymbolDef => ({
    symbol: sym(file, kind === "type" ? `${name}#` : `${name}().`),
    file,
    line: 1,
    name,
    kind,
  });
  const defs = [
    d("app/deep/er/still/x.py", "x"),
    d("tools/z.py", "z"),
    d("app/deep/y.py", "Base", "type"),
    d("tools/z.py", "Impl", "type"),
  ];
  const idx: ReferenceIndex = {
    files,
    definitions: new Map(defs.map((x) => [x.symbol, x])),
    references: [
      { symbol: defs[0]!.symbol, file: "main.py", line: 1, caller: "m", typeOnly: false },
      { symbol: defs[1]!.symbol, file: "main.py", line: 2, caller: "m", typeOnly: false },
    ],
    implementations: new Map([
      [defs[2]!.symbol, [defs[3]!.symbol]],
      ["scip-typescript npm typescript 5.0 lib/`lib.es5.d.ts`/Error#", [defs[3]!.symbol]],
      [sym("app/deep/y.py", "Base#run()."), [sym("tools/z.py", "Impl#run().")]],
    ]),
    barrels: [],
    gaps: [],
  };
  const pySources: Record<string, string> = {
    "app/__main__.py": "run()\n",
    "main.py": 'if __name__ == "__main__":\n    run()\n',
    "package.json": JSON.stringify({ bin: "cli.js" }),
  };
  const pyCtx = {
    readSource: (f: string) => pySources[f],
    roots: [
      { language: "py", root: "" },
      { language: "ts", root: "" },
    ],
  };

  it("scopes to the repository root and limits brief tree depth", () => {
    const ev = buildEvidence(idx, pyCtx, { full: false });
    expect(ev.scope).toBe("");
    expect(ev.candidates.map((c) => c.id)).toEqual(["app/", "main.py", "tools/"]);
    expect(ev.tree.map((t) => t.path)).toEqual(["", "app", "app/deep", "tools"]);
    expect(buildEvidence(idx, pyCtx, { full: true }).tree.map((t) => t.path)).toContain("app/deep/er/still");
  });

  it("orders equal surfaces by candidate and reports Python entry points and string bins", () => {
    const ev = buildEvidence(idx, pyCtx, { full: false });
    expect(ev.surfaces.map((s) => s.candidate)).toEqual(["app/", "tools/"]);
    expect(ev.signals.entryPoints).toEqual([
      { file: "package.json", reason: "bin: cli.js" },
      { file: "main.py", reason: "runs as a script (__main__ guard)" },
    ]);
  });

  it("keeps type implementations that touch the scope", () => {
    expect(buildEvidence(idx, pyCtx, { full: false }).signals.implementations).toEqual([
      { type: "Base", file: "app/deep/y.py", implementations: ["Impl (tools/z.py)"] },
    ]);
    expect(buildEvidence(idx, pyCtx, { within: "tools", full: false }).signals.implementations).toHaveLength(1);
    expect(buildEvidence(idx, pyCtx, { within: "main", full: false }).signals.implementations).toEqual([]);
  });

  it("omits a missing manifest description", () => {
    const manifest: ComponentMap = {
      source: "manifest",
      warnings: [],
      components: [{ id: "app", paths: ["app/**"], criticality: "normal", contracts: [], consumers: [] }],
    };
    expect(buildEvidence(idx, { ...pyCtx, manifest }, { full: false }).manifest).toEqual([
      { id: "app", paths: ["app/**"] },
    ]);
  });
});
