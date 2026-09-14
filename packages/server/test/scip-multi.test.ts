import { describe, it, expect } from "vitest";
import {
  buildGraphFromIndex,
  rerootDocuments,
  assertIndexNotEmpty,
  IndexError,
  type ScipDocument,
} from "../src/graph/scip.js";
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
    const documents = [...rerootDocuments(tsDocs, "", "/repo"), ...rerootDocuments(pyDocs, "mcp/svc", "/repo/mcp/svc")];
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
          { symbol: DTO_TYPE, symbolRoles: 0, range: [5, 2, 10] }, // same-file use: ignored
        ],
      },
      {
        relativePath: "src/ctrl.ts",
        occurrences: [
          { symbol: DTO_TYPE, symbolRoles: 2, range: [0, 9, 17] }, // ROLE_IMPORT
          {
            symbol: "scip-typescript npm pkg 1.0 src/`ctrl.ts`/handle().",
            symbolRoles: 1,
            range: [2, 9, 15],
            enclosingRange: [2, 0, 6, 1],
          },
        ],
      },
      {
        relativePath: "src/svc.ts",
        occurrences: [{ symbol: DTO_TYPE, symbolRoles: 0, range: [3, 4, 12] }], // plain reference
      },
    ];
    const g = buildGraphFromIndex({ documents }, "/repo");
    // Type-symbol (`#`) references carry hasValueRef: false — pass 3 uses the
    // edge, pass 4 filters on the flag (#12).
    expect(g.fileRequires.get("src/ctrl.ts")).toEqual(new Map([["src/dto.ts", { hasValueRef: false }]]));
    expect(g.fileRequires.get("src/svc.ts")).toEqual(new Map([["src/dto.ts", { hasValueRef: false }]]));
    expect(g.fileRequires.has("src/dto.ts")).toBe(false); // same-file use is not a requires
    expect(g.nodes.has(DTO_TYPE)).toBe(false); // types still excluded as graph nodes
  });

  it("a value reference upgrades the edge even when type refs came first", () => {
    const TYPE = "scip-typescript npm pkg 1.0 src/`schema.ts`/User#";
    const FN = "scip-typescript npm pkg 1.0 src/`schema.ts`/makeUser().";
    const documents: ScipDocument[] = [
      {
        relativePath: "src/schema.ts",
        occurrences: [
          { symbol: TYPE, symbolRoles: 1, range: [0, 13, 17] },
          { symbol: FN, symbolRoles: 1, range: [2, 9, 17], enclosingRange: [2, 0, 4, 1] },
        ],
      },
      {
        relativePath: "src/consumer.ts",
        occurrences: [
          { symbol: TYPE, symbolRoles: 2, range: [0, 9, 13] }, // import type { User }
          { symbol: FN, symbolRoles: 0, range: [3, 4, 12] }, // makeUser() call
        ],
      },
    ];
    const g = buildGraphFromIndex({ documents }, "/repo");
    expect(g.fileRequires.get("src/consumer.ts")).toEqual(new Map([["src/schema.ts", { hasValueRef: true }]]));
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
          { symbol: FN, symbolRoles: 0, range: [3, 4, 5] }, // call inside an it() callback
        ],
      },
    ];
    const g = buildGraphFromIndex({ documents }, "/repo");
    expect(g.fileRequires.get("test/a.test.ts")).toEqual(new Map([["src/a.ts", { hasValueRef: true }]]));
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
  const J = "semanticdb maven maven/org.example/demo 1.0.0 ";
  const J_RUN = `${J}demo/App#run().`;
  const J_OVERLOAD = `${J}demo/App#run(+1).`;
  const J_CTOR = "semanticdb maven maven/org.example/demo 1.0.0 demo/App#`<init>`().";
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
        { symbol: J_FIELD, symbolRoles: 0, range: [6, 4, 7] }, // run() reads the field
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
    const tsDoc: ScipDocument[] = [
      {
        relativePath: "src/a.ts",
        occurrences: [{ symbol: TS_TERM, symbolRoles: 1, range: [0, 6, 14], enclosingRange: [0, 0, 4, 1] }],
      },
    ];
    const g = buildGraphFromIndex({ documents: tsDoc }, "/repo");
    expect(g.nodes.has(TS_TERM)).toBe(true);
    expect(g.nodes.get(TS_TERM)?.label).toBe("handlers");
  });
});

describe("call attribution boundaries", () => {
  it("attributes duplicate references to the innermost eligible caller and keeps reverse order", () => {
    const outer = `${TS_MAIN}outer().`;
    const inner = `${TS_MAIN}inner().`;
    const documents: ScipDocument[] = [
      {
        relativePath: "src/nested.ts",
        occurrences: [
          { symbol: outer, symbolRoles: 1, enclosingRange: [0, 0, 20, 0] },
          { symbol: inner, symbolRoles: 1, enclosingRange: [3, 0, 8, 0] },
          { symbol: TS_UTIL, symbolRoles: 1, enclosingRange: [25, 0, 27, 0] },
          { symbol: TS_UTIL, range: [4, 0, 1] },
          { symbol: TS_UTIL, range: [5, 0, 1] },
          { symbol: TS_UTIL, range: [12, 0, 1] },
          { symbol: TS_UTIL, symbolRoles: 2, range: [1, 0, 1] },
          { symbol: TS_UTIL, range: [30, 0, 1] },
          { symbol: "unknown", range: [4, 0, 1] },
          { symbol: TS_UTIL },
          {},
        ],
      },
    ];
    const graph = buildGraphFromIndex({ documents }, "/repo");
    expect([...graph.callAdj]).toEqual([
      [inner, [TS_UTIL]],
      [outer, [TS_UTIL]],
    ]);
    expect([...graph.callRev]).toEqual([[TS_UTIL, [inner, outer]]]);
  });

  it("excludes local, namespace, typelike, and bodyless definitions from callable nodes", () => {
    const graph = buildGraphFromIndex(
      {
        documents: [
          {
            occurrences: [
              { symbol: "local 0", symbolRoles: 1, enclosingRange: [0, 0, 2, 0] },
              { symbol: "namespace/", symbolRoles: 1, enclosingRange: [0, 0, 2, 0] },
              { symbol: "Type#", symbolRoles: 1, enclosingRange: [0, 0, 2, 0] },
              { symbol: TS_MAIN, symbolRoles: 1 },
              { symbolRoles: 1, enclosingRange: [0, 0, 2, 0] },
            ],
          },
        ],
      },
      "/repo/",
    );
    expect([...graph.nodes]).toEqual([]);
    expect([...graph.callAdj]).toEqual([]);
    expect([...graph.fileRequires]).toEqual([]);
  });
});

describe("interface-to-implementation call bridging", () => {
  // Shapes match what scip-java and scip-dotnet emit: the implementing method's
  // SymbolInformation carries an `is_implementation` relationship to the
  // interface method, and call sites through an interface-typed receiver bind
  // to the interface method symbol.
  const IFACE = "scip-java maven . . svc/TokenService#resolve().";
  const IMPL = "scip-java maven . . svc/TokenServiceImpl#resolve().";
  const CTRL = "scip-java maven . . web/TokenController#get().";
  const implDoc = (
    relationships: { symbol: string; isImplementation?: boolean; isReference?: boolean }[],
  ): ScipDocument => ({
    relativePath: "svc/TokenServiceImpl.java",
    occurrences: [{ symbol: IMPL, symbolRoles: 1, range: [3, 16, 23], enclosingRange: [3, 2, 6, 3] }],
    symbols: [{ symbol: IMPL, relationships }],
  });
  const ctrlDoc: ScipDocument = {
    relativePath: "web/TokenController.java",
    occurrences: [
      { symbol: CTRL, symbolRoles: 1, range: [5, 20, 23], enclosingRange: [5, 2, 7, 3] },
      { symbol: IFACE, symbolRoles: 0, range: [6, 18, 25] }, // tokens.resolve(...) via the interface
    ],
  };
  const ifaceDoc = (enclosingRange?: number[]): ScipDocument => ({
    relativePath: "svc/TokenService.java",
    occurrences: [{ symbol: IFACE, symbolRoles: 1, range: [2, 9, 16], ...(enclosingRange ? { enclosingRange } : {}) }],
  });

  it("a call bound to an interface method also reaches its implementations", () => {
    const documents = [
      ifaceDoc([2, 2, 2, 25]),
      implDoc([{ symbol: IFACE, isImplementation: true, isReference: true }]),
      ctrlDoc,
    ];
    const g = buildGraphFromIndex({ documents }, "/repo");
    expect(g.callAdj.get(CTRL)).toEqual([IFACE, IMPL]);
    expect(g.callRev.get(IMPL)).toEqual([CTRL]);
  });

  it("bridges even when the interface method itself has no body span", () => {
    // scip-dotnet emits no enclosingRange; interface members never become nodes there.
    const documents = [ifaceDoc(), implDoc([{ symbol: IFACE, isImplementation: true }]), ctrlDoc];
    const g = buildGraphFromIndex({ documents }, "/repo");
    expect(g.nodes.has(IFACE)).toBe(false);
    expect(g.callAdj.get(CTRL)).toEqual([IMPL]);
  });

  it("ignores relationships that are not implementations", () => {
    const documents = [ifaceDoc([2, 2, 2, 25]), implDoc([{ symbol: IFACE, isReference: true }]), ctrlDoc];
    const g = buildGraphFromIndex({ documents }, "/repo");
    expect(g.callAdj.get(CTRL)).toEqual([IFACE]);
    expect(g.callRev.has(IMPL)).toBe(false);
  });

  it("never bridges a call back onto the calling method itself", () => {
    // TokenServiceImpl#resolve calls the interface method (e.g. on a delegate);
    // bridging must not add a self-edge IMPL -> IMPL.
    const selfCalling: ScipDocument = {
      ...implDoc([{ symbol: IFACE, isImplementation: true }]),
      occurrences: [
        { symbol: IMPL, symbolRoles: 1, range: [3, 16, 23], enclosingRange: [3, 2, 6, 3] },
        { symbol: IFACE, symbolRoles: 0, range: [4, 20, 27] },
      ],
    };
    const documents = [ifaceDoc([2, 2, 2, 25]), selfCalling];
    const g = buildGraphFromIndex({ documents }, "/repo");
    expect(g.callAdj.get(IMPL)).toEqual([IFACE]);
  });
});

describe("c# symbol shapes", () => {
  const CTOR = "scip-dotnet nuget . . Controllers/TokenController#`.ctor`().";
  const GET = "scip-dotnet nuget . . Controllers/TokenController#Get().";
  const OVERLOAD = "scip-dotnet nuget . . Core/TokenService#Resolve(+1).";
  it("labels constructors with the class name and keeps overloads as nodes", () => {
    const documents: ScipDocument[] = [
      {
        relativePath: "src/TokenController.cs",
        occurrences: [
          { symbol: CTOR, symbolRoles: 1, range: [3, 11, 26], enclosingRange: [3, 0, 3, 60] },
          { symbol: GET, symbolRoles: 1, range: [5, 32, 35], enclosingRange: [5, 0, 5, 70] },
          { symbol: OVERLOAD, symbolRoles: 1, range: [8, 18, 25], enclosingRange: [8, 0, 8, 80] },
        ],
      },
    ];
    const g = buildGraphFromIndex({ documents }, "/repo");
    expect(g.nodes.get(CTOR)?.label).toBe("TokenController");
    expect(g.nodes.get(GET)?.label).toBe("Get");
    expect(g.nodes.get(OVERLOAD)?.label).toBe("Resolve");
  });
});
