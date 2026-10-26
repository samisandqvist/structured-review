// The reference index is the symbol-level view the component map reasons
// over: definitions with names and kinds, and cross-file references with
// their enclosing caller and whether they only use a type.
import { describe, it, expect } from "vitest";
import {
  buildReferenceIndex,
  importLines,
  unindexedGaps,
  symbolKind,
  symbolName,
  type IndexedDocument,
} from "../src/graph/references.js";

const TS = "scip-typescript npm pkg 1.0";
const sym = (file: string, desc: string) => {
  const at = file.lastIndexOf("/");
  return `${TS} ${file.slice(0, at + 1)}\`${file.slice(at + 1)}\`/${desc}`;
};
const GET_JOB = sym("src/store/jobs.ts", "getJob().");
const JOB = sym("src/store/jobs.ts", "Job#");
const JOB_STATUS = sym("src/store/jobs.ts", "Job#status.");
const LIMIT = sym("src/store/jobs.ts", "LIMIT.");
const HANDLE = sym("src/api/handler.ts", "handle().");
const REPO = sym("src/store/repo.ts", "Repo#");
const REPO_FIND = sym("src/store/repo.ts", "Repo#find().");

const sources: Record<string, string> = {
  "src/api/handler.ts": [
    'import { getJob, type Job, LIMIT } from "../store/jobs.js";',
    "const top = getJob(0);",
    "export function handle(job: Job): number {",
    "  const r = new Repo();",
    "  return getJob(LIMIT) + job.status + Repo(1);",
    "}",
  ].join("\n"),
};

function docs(): IndexedDocument[] {
  return [
    {
      file: "src/store/jobs.ts",
      occurrences: [
        { symbol: GET_JOB, symbolRoles: 1, range: [0, 16, 22], enclosingRange: [0, 0, 2, 1] },
        { symbol: JOB, symbolRoles: 1, range: [3, 17, 20], enclosingRange: [3, 0, 5, 1] },
        { symbol: JOB_STATUS, symbolRoles: 1, range: [4, 2, 8] },
        { symbol: LIMIT, symbolRoles: 1, range: [6, 13, 18] },
        { symbol: GET_JOB, symbolRoles: 0, range: [7, 0, 6] },
      ],
      symbols: [],
    },
    {
      file: "src/store/repo.ts",
      occurrences: [
        { symbol: REPO, symbolRoles: 1, range: [0, 13, 17], enclosingRange: [0, 0, 4, 1] },
        { symbol: REPO_FIND, symbolRoles: 1, range: [1, 2, 6], enclosingRange: [1, 2, 3, 3] },
      ],
      symbols: [
        { symbol: REPO, relationships: [{ symbol: sym("src/store/types.ts", "Finder#"), isImplementation: true }] },
      ],
    },
    {
      file: "src/api/handler.ts",
      occurrences: [
        { symbol: GET_JOB, symbolRoles: 0, range: [0, 9, 15] },
        { symbol: GET_JOB, symbolRoles: 0, range: [1, 12, 18] },
        { symbol: HANDLE, symbolRoles: 1, range: [2, 16, 22], enclosingRange: [2, 0, 5, 1] },
        { symbol: JOB, symbolRoles: 0, range: [2, 28, 31] },
        { symbol: REPO, symbolRoles: 0, range: [3, 16, 20] },
        { symbol: GET_JOB, symbolRoles: 0, range: [4, 9, 15] },
        { symbol: LIMIT, symbolRoles: 0, range: [4, 16, 21] },
        { symbol: JOB_STATUS, symbolRoles: 0, range: [4, 29, 35] },
        { symbol: REPO, symbolRoles: 0, range: [4, 38, 42] },
        { symbol: "local 3", symbolRoles: 0, range: [4, 2, 3] },
        { symbol: `${TS} react 18 \`index.d.ts\`/useState().`, symbolRoles: 0, range: [4, 1, 2] },
      ],
      symbols: [],
    },
  ];
}

describe("symbolName and symbolKind", () => {
  it.each([
    [GET_JOB, "getJob", "function"],
    [REPO_FIND, "Repo#find", "method"],
    [LIMIT, "LIMIT", "value"],
    [JOB_STATUS, "Job#status", "field"],
    [JOB, "Job", "type"],
    [sym("src/store/jobs.ts", ""), "", "module"],
    [sym("src/store/jobs.ts", "getJob().(id)"), "getJob().(id)", "other"],
    ["scip-python python app 0.1 `app.jobs`/Runner#run().", "Runner#run", "method"],
    ["scip-python python app 0.1 `app.jobs`/run_all().", "run_all", "function"],
    ["local 7", "local 7", "other"],
    ["scip-python python repo 5b60 httpie/__version__.", "__version__", "value"],
    ["scip-python python repo 5b60 `httpie.manager.tasks`/__init__:", "__init__:", "other"],
    ["scip-typescript npm @scope/pkg 1.0 lib/`a b.ts`/run().", "run", "function"],
    [sym("src/a.ts", "connect().(target)typeLiteral0:url."), "connect().(target)typeLiteral0:url", "field"],
    [sym("src/a.ts", "save().Promise:typeLiteral0:version."), "save().Promise:typeLiteral0:version", "field"],
  ])("%s", (symbol, name, kind) => {
    expect(symbolName(symbol)).toBe(name);
    expect(symbolKind(symbol)).toBe(kind);
  });
});

const index = buildReferenceIndex(docs(), (f) => sources[f], ["a gap"]);
const refs = (symbol: string) => index.references.filter((r) => r.symbol === symbol);

describe("buildReferenceIndex", () => {
  it("indexes definitions with file, 1-based line, name and kind", () => {
    expect(index.definitions.get(REPO_FIND)).toEqual({
      symbol: REPO_FIND,
      file: "src/store/repo.ts",
      line: 2,
      name: "Repo#find",
      kind: "method",
    });
  });

  it("keeps cross-file value references and drops imports, same-file uses and unindexed symbols", () => {
    expect(refs(GET_JOB).map((r) => r.line)).toEqual([2, 5]);
    expect(index.references.every((r) => r.file !== "src/store/jobs.ts")).toBe(true);
    expect(index.references.some((r) => r.symbol.includes("react"))).toBe(false);
  });

  it("excludes field accesses", () => {
    expect(refs(JOB_STATUS)).toEqual([]);
  });

  it("attributes the innermost enclosing definition as caller and (module) at top level", () => {
    expect(refs(GET_JOB).map((r) => r.caller)).toEqual(["(module)", "handle"]);
  });

  it("marks a bare type annotation as typeOnly", () => {
    expect(refs(JOB)).toEqual([{ symbol: JOB, file: "src/api/handler.ts", line: 3, caller: "handle", typeOnly: true }]);
  });

  it("treats new Foo and Foo( as value references", () => {
    expect(refs(REPO).map((r) => r.typeOnly)).toEqual([false, false]);
  });

  it("treats a type reference as typeOnly when the source is unavailable", () => {
    const blind = buildReferenceIndex(docs(), () => undefined, []);
    expect(blind.references.filter((r) => r.symbol === REPO).every((r) => r.typeOnly)).toBe(true);
  });
});

describe("buildReferenceIndex signals and scope", () => {
  it("collects implementations", () => {
    expect(index.implementations.get(sym("src/store/types.ts", "Finder#"))).toEqual([REPO]);
  });

  it("lists mapped files and carries gaps", () => {
    expect(index.files).toEqual(["src/api/handler.ts", "src/store/jobs.ts", "src/store/repo.ts"]);
    expect(index.gaps).toEqual(["a gap"]);
  });

  it("skips test files and unmapped languages", () => {
    const extra: IndexedDocument[] = [
      {
        file: "src/api/handler.test.ts",
        occurrences: [{ symbol: GET_JOB, symbolRoles: 0, range: [1, 0, 6] }],
        symbols: [],
      },
      {
        file: "src/Main.java",
        occurrences: [{ symbol: "semanticdb maven x 1 com/Main#run().", symbolRoles: 1, range: [1, 0, 3] }],
        symbols: [],
      },
    ];
    const idx = buildReferenceIndex([...docs(), ...extra], (f) => sources[f], []);
    expect(idx.files).not.toContain("src/api/handler.test.ts");
    expect(idx.files).not.toContain("src/Main.java");
    expect(idx.references.some((r) => r.file.endsWith(".test.ts"))).toBe(false);
  });

  it("groups barrel re-exports by defining file", () => {
    const barrel: IndexedDocument = {
      file: "src/store/index.ts",
      occurrences: [
        { symbol: sym("src/store/index.ts", ""), symbolRoles: 1, range: [0, 0, 0] },
        { symbol: GET_JOB, symbolRoles: 0, range: [0, 9, 15] },
        { symbol: LIMIT, symbolRoles: 0, range: [0, 17, 22] },
        { symbol: REPO, symbolRoles: 0, range: [1, 9, 13] },
        { symbol: JOB_STATUS, symbolRoles: 0, range: [2, 0, 6] },
      ],
      symbols: [],
    };
    const idx = buildReferenceIndex([...docs(), barrel], (f) => sources[f], []);
    expect(idx.barrels).toEqual([
      {
        file: "src/store/index.ts",
        exports: [
          { from: "src/store/jobs.ts", names: ["getJob", "LIMIT"] },
          { from: "src/store/repo.ts", names: ["Repo"] },
        ],
      },
    ]);
  });
});

describe("value uses of a type", () => {
  const T = sym("src/t.ts", "Formatter#");
  const lines = [
    "register(Formatter, Other);",
    "if (e instanceof Formatter) {}",
    "const x: Formatter = make();",
    "function f(a: Map<string, Formatter>) {}",
    "class A extends Formatter {}",
    "Formatter.create();",
    "const all = [Other, Formatter];",
    "def f(x: Formatter) -> Formatter:",
  ];
  const doc: IndexedDocument = {
    file: "src/use.ts",
    occurrences: lines.map((text, i) => {
      const at = text.lastIndexOf("Formatter");
      return { symbol: T, symbolRoles: 0, range: [i, at, at + 9] };
    }),
    symbols: [],
  };
  const defs: IndexedDocument = {
    file: "src/t.ts",
    occurrences: [{ symbol: T, symbolRoles: 1, range: [0, 13, 22] }],
    symbols: [],
  };
  const idx = buildReferenceIndex([defs, doc], () => lines.join("\n"), []);

  it("treats arguments, instanceof, static access and list items as values and annotations as types", () => {
    expect(idx.references.map((r) => r.typeOnly)).toEqual([false, false, true, true, true, false, false, true]);
  });
});

describe("importLines", () => {
  it("finds TypeScript import and re-export statements, including multi-line ones", () => {
    const src = [
      'import { a } from "./a.js";',
      "import {",
      "  b,",
      "  type C,",
      '} from "./b.js";',
      'import "./side.js";',
      'export { d } from "./d.js";',
      'export * from "./e.js";',
      "export const x = a(b);",
      'import fs = require("fs");',
    ].join("\n");
    expect([...importLines(src, "src/x.ts")]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 9]);
  });

  it("finds Python import statements, including parenthesized ones", () => {
    const src = ["import os", "from .a import (", "    b,", "    c,", ")", "from x import y", "z = b()"].join("\n");
    expect([...importLines(src, "pkg/m.py")]).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("unindexedGaps", () => {
  it("reports tracked mapped-language sources missing from the index, by directory", () => {
    const tracked = [
      "src/a.ts",
      "scripts/x.ts",
      "scripts/y.mjs",
      "tools/z.py",
      "README.md",
      "src/a.test.ts",
      "Main.java",
      "setup.py",
    ];
    expect(unindexedGaps(tracked, ["src/a.ts"])).toEqual([
      "1 Python file in . is not in the index (outside every indexed project); the map does not cover it",
      "2 TypeScript/JavaScript files in scripts/ are not in the index (outside every indexed project); the map does not cover them",
      "1 Python file in tools/ is not in the index (outside every indexed project); the map does not cover it",
    ]);
  });
});
