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
