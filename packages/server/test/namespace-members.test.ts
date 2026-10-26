// `import * as store from "./store/index.js"; store.getJob()` is recorded by
// scip-typescript with a `local N` symbol for `getJob`. The decoder resolves
// such members through the module's own definitions and re-exports.
import { describe, it, expect } from "vitest";
import { resolveNamespaceMembers, type NamespaceDocument } from "../src/graph/namespace-members.js";
import { buildGraphFromIndex } from "../src/graph/scip.js";

const PKG = "scip-typescript npm pkg 1.0";
const INDEX_MODULE = `${PKG} src/store/\`index.ts\`/`;
const JOBS_MODULE = `${PKG} src/store/\`jobs.ts\`/`;
const GET_JOB = `${PKG} src/store/\`jobs.ts\`/getJob().`;
const HANDLE = `${PKG} src/api/\`handler.ts\`/handle().`;

const sources: Record<string, string> = {
  "src/store/index.ts": 'export { getJob } from "./jobs.js";\n',
  "src/store/star.ts": 'export * from "./jobs.js";\n',
  "src/store/jobs.ts": "export function getJob(id: number) {\n  return id;\n}\n",
  "src/api/handler.ts": [
    'import * as store from "../store/index.js";',
    "",
    "export function handle() {",
    "  store.getJob(1);",
    "  store .getJob(2);",
    "  store.missing(3);",
    "  const local = 1; local.toString();",
    "}",
  ].join("\n"),
};
const readSource = (file: string) => sources[file];

function jobs(): NamespaceDocument {
  return {
    file: "src/store/jobs.ts",
    occurrences: [
      { symbol: JOBS_MODULE, symbolRoles: 1, range: [0, 0, 0] },
      { symbol: GET_JOB, symbolRoles: 1, range: [0, 16, 22] },
    ],
  };
}
function barrel(): NamespaceDocument {
  return {
    file: "src/store/index.ts",
    occurrences: [
      { symbol: INDEX_MODULE, symbolRoles: 1, range: [0, 0, 0] },
      { symbol: GET_JOB, symbolRoles: 0, range: [0, 9, 15] },
    ],
  };
}
function caller(module: string, member: number[], symbol = "local 4"): NamespaceDocument {
  const line = member[0]!;
  return {
    file: "src/api/handler.ts",
    occurrences: [
      { symbol: module, symbolRoles: 0, range: [line, 2, 7] },
      { symbol, symbolRoles: 0, range: member },
    ],
  };
}

describe("resolveNamespaceMembers", () => {
  it("resolves ns.fn() to the definition the module re-exports", () => {
    const docs = [jobs(), barrel(), caller(INDEX_MODULE, [3, 8, 14])];
    expect(resolveNamespaceMembers(docs, readSource)).toBe(1);
    expect(docs[2]!.occurrences[1]!.symbol).toBe(GET_JOB);
  });

  it("resolves a member the module defines itself", () => {
    const docs = [jobs(), caller(JOBS_MODULE, [3, 8, 14])];
    expect(resolveNamespaceMembers(docs, readSource)).toBe(1);
    expect(docs[1]!.occurrences[1]!.symbol).toBe(GET_JOB);
  });

  it("prefers the module's own definition over a same-named import", () => {
    const own = `${PKG} src/store/\`index.ts\`/getJob().`;
    const wrapper: NamespaceDocument = {
      file: "src/store/index.ts",
      occurrences: [
        { symbol: GET_JOB, symbolRoles: 0, range: [0, 9, 15] },
        { symbol: own, symbolRoles: 1, range: [1, 16, 22] },
      ],
    };
    const docs = [jobs(), wrapper, caller(INDEX_MODULE, [3, 8, 14])];
    expect(resolveNamespaceMembers(docs, readSource)).toBe(1);
    expect(docs[2]!.occurrences[1]!.symbol).toBe(own);
  });

  it("follows export * chains", () => {
    const starModule = `${PKG} src/store/\`star.ts\`/`;
    const star: NamespaceDocument = {
      file: "src/store/star.ts",
      occurrences: [
        { symbol: starModule, symbolRoles: 1, range: [0, 0, 0] },
        { symbol: JOBS_MODULE, symbolRoles: 0, range: [0, 14, 25] },
      ],
    };
    const docs = [jobs(), star, caller(starModule, [3, 8, 14])];
    expect(resolveNamespaceMembers(docs, readSource)).toBe(1);
    expect(docs[2]!.occurrences[1]!.symbol).toBe(GET_JOB);
  });

  it("stops on export * cycles", () => {
    const a = `${PKG} src/\`a.ts\`/`;
    const b = `${PKG} src/\`b.ts\`/`;
    const src: Record<string, string> = {
      "src/a.ts": 'export * from "./b.js";\n',
      "src/b.ts": 'export * from "./a.js";\n',
      "src/api/handler.ts": sources["src/api/handler.ts"]!,
    };
    const docs: NamespaceDocument[] = [
      { file: "src/a.ts", occurrences: [{ symbol: b, symbolRoles: 0, range: [0, 14, 22] }] },
      { file: "src/b.ts", occurrences: [{ symbol: a, symbolRoles: 0, range: [0, 14, 22] }] },
      caller(a, [3, 8, 14]),
    ];
    expect(resolveNamespaceMembers(docs, (f) => src[f])).toBe(0);
    expect(docs[2]!.occurrences[1]!.symbol).toBe("local 4");
  });
});

describe("resolveNamespaceMembers leaves what it cannot resolve", () => {
  it("leaves locals that do not follow a module occurrence", () => {
    const doc: NamespaceDocument = {
      file: "src/api/handler.ts",
      occurrences: [
        { symbol: "local 1", symbolRoles: 1, range: [6, 8, 13] },
        { symbol: "local 1", symbolRoles: 0, range: [6, 19, 24] },
        { symbol: "local 2", symbolRoles: 0, range: [6, 25, 33] },
      ],
    };
    expect(resolveNamespaceMembers([jobs(), doc], readSource)).toBe(0);
    expect(doc.occurrences.map((o) => o.symbol)).toEqual(["local 1", "local 1", "local 2"]);
  });

  it("leaves a local separated from the module by more than a dot", () => {
    const docs = [jobs(), barrel(), caller(INDEX_MODULE, [4, 9, 15])];
    expect(resolveNamespaceMembers(docs, readSource)).toBe(0);
  });

  it("leaves an unknown member local", () => {
    const docs = [jobs(), barrel(), caller(INDEX_MODULE, [5, 8, 15])];
    expect(resolveNamespaceMembers(docs, readSource)).toBe(0);
    expect(docs[2]!.occurrences[1]!.symbol).toBe("local 4");
  });

  it("leaves a member of a module that is not indexed", () => {
    const docs = [caller(`${PKG} node_modules/\`x.ts\`/`, [3, 8, 14])];
    expect(resolveNamespaceMembers(docs, readSource)).toBe(0);
  });

  it("accepts four-element single-line ranges and skips multi-line or missing ranges", () => {
    const doc = caller(INDEX_MODULE, [3, 8, 3, 14]);
    doc.occurrences.push({ symbol: "local 9", symbolRoles: 0, range: [3, 8, 4, 2] }, { symbolRoles: 0 });
    const docs = [jobs(), barrel(), doc];
    expect(resolveNamespaceMembers(docs, readSource)).toBe(1);
    expect(doc.occurrences[1]!.symbol).toBe(GET_JOB);
  });

  it("leaves members of package-level module symbols", () => {
    const docs = [jobs(), caller(`${PKG} lodash/`, [3, 8, 14])];
    expect(resolveNamespaceMembers(docs, readSource)).toBe(0);
  });

  it("finds a module in another indexer root by its path suffix", () => {
    const rooted = { ...jobs(), file: "services/api/src/store/jobs.ts" };
    const docs = [rooted, caller(JOBS_MODULE, [3, 8, 14])];
    expect(resolveNamespaceMembers(docs, readSource)).toBe(1);
  });

  it("does not guess between two roots with the same module path", () => {
    const docs = [
      { ...jobs(), file: "a/src/store/jobs.ts" },
      { ...jobs(), file: "b/src/store/jobs.ts" },
      caller(JOBS_MODULE, [3, 8, 14]),
    ];
    expect(resolveNamespaceMembers(docs, readSource)).toBe(0);
  });

  it("survives a missing source file", () => {
    const docs = [jobs(), barrel(), caller(INDEX_MODULE, [3, 8, 14])];
    expect(resolveNamespaceMembers(docs, () => undefined)).toBe(0);
  });

  it("resolves occurrences listed out of source order", () => {
    const doc = caller(INDEX_MODULE, [3, 8, 14]);
    doc.occurrences.reverse();
    const docs = [jobs(), barrel(), doc];
    expect(resolveNamespaceMembers(docs, readSource)).toBe(1);
  });
});

describe("buildGraphFromIndex with namespace members", () => {
  it("counts a namespace member call as a call edge", () => {
    const handler = caller(INDEX_MODULE, [3, 8, 14]);
    handler.occurrences.unshift({ symbol: HANDLE, symbolRoles: 1, range: [2, 16, 22], enclosingRange: [2, 0, 7, 1] });
    const jobsDoc = jobs();
    jobsDoc.occurrences[1]!.enclosingRange = [0, 0, 2, 1];
    const documents = [jobsDoc, barrel(), handler].map((d) => ({ relativePath: d.file, occurrences: d.occurrences }));
    const g = buildGraphFromIndex({ documents }, "/repo", readSource);
    expect(g.callAdj.get(HANDLE)).toEqual([GET_JOB]);
  });
});
