import { describe, it, expect } from "vitest";
import { buildGraphFromIndex, rerootDocuments, assertIndexNotEmpty, IndexError, type ScipDocument } from "../src/graph/scip.js";
import type { IndexerJob } from "../src/graph/roots.js";

const TS_MAIN = "scip-typescript npm pkg 1.0 src/`a.ts`/f().";
const TS_UTIL = "scip-typescript npm pkg 1.0 src/`a.ts`/g().";
const PY_MAIN = "scip-python python svc 0.0.1 app/main().";
const PY_GREET = "scip-python python svc 0.0.1 helper/greet().";

const tsDocs: ScipDocument[] = [
  {
    relativePath: "src/a.ts",
    occurrences: [
      { symbol: TS_MAIN, symbolRoles: 1, range: [0, 9, 10], enclosingRange: [0, 0, 4, 1] },
      { symbol: TS_UTIL, symbolRoles: 1, range: [6, 9, 10], enclosingRange: [6, 0, 8, 1] },
      { symbol: TS_UTIL, symbolRoles: 0, range: [2, 2, 3] }, // f calls g
    ],
  },
];
const pyDocs: ScipDocument[] = [
  {
    relativePath: "app.py",
    occurrences: [
      { symbol: PY_MAIN, symbolRoles: 1, range: [2, 4, 8], enclosingRange: [2, 0, 4, 0] },
      { symbol: PY_GREET, symbolRoles: 0, range: [3, 10, 15] }, // main calls greet
    ],
  },
  {
    relativePath: "helper.py",
    occurrences: [{ symbol: PY_GREET, symbolRoles: 1, range: [0, 4, 9], enclosingRange: [0, 0, 1, 0] }],
  },
];

describe("rerootDocuments", () => {
  it("prefixes the job root onto each document path", () => {
    const out = rerootDocuments(pyDocs, "mcp/svc", "/repo/mcp/svc");
    expect(out.map((d) => d.relativePath)).toEqual(["mcp/svc/app.py", "mcp/svc/helper.py"]);
  });

  it("strips an absolute indexer-root prefix before prefixing", () => {
    const abs: ScipDocument[] = [{ relativePath: "/repo/mcp/svc/app.py", occurrences: [] }];
    expect(rerootDocuments(abs, "mcp/svc", "/repo/mcp/svc")[0].relativePath).toBe("mcp/svc/app.py");
  });

  it("is the identity for a repo-root job", () => {
    expect(rerootDocuments(tsDocs, "", "/repo").map((d) => d.relativePath)).toEqual(["src/a.ts"]);
  });

  it("does not mutate its input", () => {
    rerootDocuments(pyDocs, "mcp/svc", "/repo/mcp/svc");
    expect(pyDocs[0].relativePath).toBe("app.py");
  });
});

describe("merged multi-root graph", () => {
  it("builds one graph with repo-relative paths and per-root call edges", () => {
    const documents = [
      ...rerootDocuments(tsDocs, "", "/repo"),
      ...rerootDocuments(pyDocs, "mcp/svc", "/repo/mcp/svc"),
    ];
    const g = buildGraphFromIndex({ documents }, "/repo");
    expect(g.nodes.get(TS_MAIN)?.file).toBe("src/a.ts");
    expect(g.nodes.get(PY_MAIN)?.file).toBe("mcp/svc/app.py");
    expect(g.nodes.get(PY_GREET)?.file).toBe("mcp/svc/helper.py");
    expect(g.callAdj.get(TS_MAIN)).toEqual([TS_UTIL]);
    expect(g.callAdj.get(PY_MAIN)).toEqual([PY_GREET]);
  });
});

describe("file-level requires map", () => {
  const DTO_TYPE = "scip-typescript npm pkg 1.0 src/`dto.ts`/OrderDto#";
  it("maps cross-file type references and imports to the defining file", () => {
    const documents: ScipDocument[] = [
      {
        relativePath: "src/dto.ts",
        occurrences: [
          { symbol: DTO_TYPE, symbolRoles: 1, range: [0, 13, 21] }, // type definition
          { symbol: DTO_TYPE, symbolRoles: 0, range: [5, 2, 10] },  // same-file use: ignored
        ],
      },
      {
        relativePath: "src/ctrl.ts",
        occurrences: [
          { symbol: DTO_TYPE, symbolRoles: 2, range: [0, 9, 17] }, // ROLE_IMPORT
          { symbol: "scip-typescript npm pkg 1.0 src/`ctrl.ts`/handle().", symbolRoles: 1, range: [2, 9, 15], enclosingRange: [2, 0, 6, 1] },
        ],
      },
      {
        relativePath: "src/svc.ts",
        occurrences: [{ symbol: DTO_TYPE, symbolRoles: 0, range: [3, 4, 12] }], // plain reference
      },
    ];
    const g = buildGraphFromIndex({ documents }, "/repo");
    expect(g.fileRequires.get("src/ctrl.ts")).toEqual(new Set(["src/dto.ts"]));
    expect(g.fileRequires.get("src/svc.ts")).toEqual(new Set(["src/dto.ts"]));
    expect(g.fileRequires.has("src/dto.ts")).toBe(false); // same-file use is not a requires
    expect(g.nodes.has(DTO_TYPE)).toBe(false); // types still excluded as graph nodes
  });

  it("includes function imports/references, so test files require what they import", () => {
    const FN = "scip-typescript npm pkg 1.0 src/`a.ts`/f().";
    const documents: ScipDocument[] = [
      {
        relativePath: "src/a.ts",
        occurrences: [{ symbol: FN, symbolRoles: 1, range: [0, 9, 10], enclosingRange: [0, 0, 4, 1] }],
      },
      {
        relativePath: "test/a.test.ts",
        occurrences: [
          { symbol: FN, symbolRoles: 2, range: [0, 9, 10] }, // import { f }
          { symbol: FN, symbolRoles: 0, range: [3, 4, 5] },  // call inside an it() callback
        ],
      },
    ];
    const g = buildGraphFromIndex({ documents }, "/repo");
    expect(g.fileRequires.get("test/a.test.ts")).toEqual(new Set(["src/a.ts"]));
  });
});

describe("IndexError", () => {
  it("carries the index phase", () => {
    const e = new IndexError("scip-python failed");
    expect(e.phase).toBe("index");
    expect(e.name).toBe("IndexError");
    expect(e).toBeInstanceOf(Error);
  });
});

describe("assertIndexNotEmpty", () => {
  const job = (hasSources: boolean, overrides: Partial<IndexerJob> = {}): IndexerJob => ({
    language: "ts",
    root: "svc",
    hasSources,
    ...overrides,
  });

  it("throws IndexError (phase 'index') for an empty index when the root has sources", () => {
    expect(() => assertIndexNotEmpty([], job(true))).toThrow(IndexError);
    try {
      assertIndexNotEmpty([], job(true));
      throw new Error("expected assertIndexNotEmpty to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(IndexError);
      expect((e as IndexError).phase).toBe("index");
    }
  });

  it("does not throw for an empty index when the root has no sources", () => {
    expect(() => assertIndexNotEmpty([], job(false))).not.toThrow();
  });

  it("does not throw for a non-empty index", () => {
    const docs: ScipDocument[] = [{ relativePath: "svc/a.ts", occurrences: [] }];
    expect(() => assertIndexNotEmpty(docs, job(true))).not.toThrow();
  });
});

describe("python symbol shapes (audit lock-in)", () => {
  // Real scip-python shapes: backticked dotted module descriptor, `#` for
  // methods, `().` suffix for callables.
  const PY_FN = "scip-python python svc 0.0.1 `app.web`/handler().";
  const PY_METHOD = "scip-python python svc 0.0.1 `app.client`/Client#send().";

  it("labels backticked-module functions and #-methods by their trailing identifier", () => {
    const documents: ScipDocument[] = [
      {
        relativePath: "app/web.py",
        occurrences: [
          { symbol: PY_FN, symbolRoles: 1, range: [0, 4, 11], enclosingRange: [0, 0, 2, 0] },
          { symbol: PY_METHOD, symbolRoles: 0, range: [1, 4, 10] }, // handler calls Client.send
        ],
      },
      {
        relativePath: "app/client.py",
        occurrences: [{ symbol: PY_METHOD, symbolRoles: 1, range: [1, 8, 12], enclosingRange: [1, 4, 3, 0] }],
      },
    ];
    const g = buildGraphFromIndex({ documents }, "/repo");
    expect(g.nodes.get(PY_FN)?.label).toBe("handler");
    expect(g.nodes.get(PY_METHOD)?.label).toBe("send");
    expect(g.callAdj.get(PY_FN)).toEqual([PY_METHOD]);
  });
});

describe("java symbol shapes (spike deltas)", () => {
  const J = "semanticdb maven maven/fi.pareto/demo 1.0.0 ";
  const J_RUN = `${J}demo/App#run().`;
  const J_OVERLOAD = `${J}demo/App#run(+1).`;
  const J_CTOR = "semanticdb maven maven/fi.pareto/demo 1.0.0 demo/App#`<init>`().";
  const J_FIELD = `${J}demo/App#svc.`;
  const J_GREET = `${J}demo/Svc#greet().`;

  const javaDocs: ScipDocument[] = [
    {
      relativePath: "src/main/java/demo/App.java",
      occurrences: [
        // scip-java gives ALL of these an enclosingRange — fields included.
        { symbol: J_CTOR, symbolRoles: 1, range: [2, 9, 12], enclosingRange: [2, 2, 4, 3] },
        { symbol: J_RUN, symbolRoles: 1, range: [5, 16, 19], enclosingRange: [5, 2, 7, 3] },
        { symbol: J_OVERLOAD, symbolRoles: 1, range: [8, 16, 19], enclosingRange: [8, 2, 10, 3] },
        { symbol: J_FIELD, symbolRoles: 1, range: [1, 20, 23], enclosingRange: [1, 2, 1, 30] },
        { symbol: J_FIELD, symbolRoles: 0, range: [6, 4, 7] },  // run() reads the field
        { symbol: J_GREET, symbolRoles: 0, range: [6, 8, 13] }, // run() calls Svc#greet()
      ],
    },
    {
      relativePath: "src/main/java/demo/Svc.java",
      occurrences: [{ symbol: J_GREET, symbolRoles: 1, range: [1, 16, 21], enclosingRange: [1, 2, 3, 3] }],
    },
  ];

  it("keeps only method-descriptor symbols as nodes in .java documents", () => {
    const g = buildGraphFromIndex({ documents: javaDocs }, "/repo");
    expect(g.nodes.has(J_RUN)).toBe(true);
    expect(g.nodes.has(J_GREET)).toBe(true);
    expect(g.nodes.has(J_FIELD)).toBe(false); // field def carries enclosingRange but is not a node
  });

  it("keeps overloads ((+N). descriptors) and labels them", () => {
    const g = buildGraphFromIndex({ documents: javaDocs }, "/repo");
    expect(g.nodes.get(J_OVERLOAD)?.label).toBe("run");
  });

  it("labels constructors with the class name", () => {
    const g = buildGraphFromIndex({ documents: javaDocs }, "/repo");
    expect(g.nodes.get(J_CTOR)?.label).toBe("App");
  });

  it("derives method-level call edges and no field-read edges", () => {
    const g = buildGraphFromIndex({ documents: javaDocs }, "/repo");
    expect(g.callAdj.get(J_RUN)).toEqual([J_GREET]);
  });

  it("does not apply the java node filter to non-java documents", () => {
    // A term-shaped symbol (no `).` suffix) with an enclosingRange in a .ts
    // document must remain a node: only .java documents get the
    // method-descriptor filter. This is the shape that would be wrongly
    // dropped if the filter lost its file scoping.
    const TS_TERM = "scip-typescript npm pkg 1.0 src/`a.ts`/handlers.";
    const tsDoc: ScipDocument[] = [{
      relativePath: "src/a.ts",
      occurrences: [{ symbol: TS_TERM, symbolRoles: 1, range: [0, 6, 14], enclosingRange: [0, 0, 4, 1] }],
    }];
    const g = buildGraphFromIndex({ documents: tsDoc }, "/repo");
    expect(g.nodes.has(TS_TERM)).toBe(true);
    expect(g.nodes.get(TS_TERM)?.label).toBe("handlers");
  });
});
