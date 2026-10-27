// A small resolved component map: a job orchestrator with an operator API,
// a core with two parts, a persistence facade, a hidden utility and two
// external systems.
import type { CallSite, CheckReport, ResolvedComponent, ResolvedInterface, ResolvedMap } from "../src/map/types.js";

const component = (
  id: string,
  name: string,
  parent: string | null,
  extra: Partial<ResolvedComponent> = {},
): ResolvedComponent => ({
  id,
  name,
  parent,
  meaning: `${name} meaning`,
  paths: extra.external ? [] : [`src/${id}/`],
  external: false,
  utility: false,
  fileCount: 2,
  ...extra,
});

const site = (file: string, symbol: string, component: string, requirer: string, undeclared = false): CallSite => ({
  file,
  line: 3,
  caller: "caller",
  symbol,
  component,
  requirer,
  undeclared,
});

const iface = (
  id: string,
  name: string,
  provider: string,
  requirers: string[],
  extra: Partial<ResolvedInterface> = {},
): ResolvedInterface => ({
  id,
  name,
  provider,
  requirers,
  meaning: `${name} meaning`,
  bind: [],
  evidence: [],
  bindings: [],
  sites: [],
  evidenceFiles: [],
  reasons: [],
  ...extra,
});

const report: CheckReport = {
  ok: true,
  coverage: { references: 6, covered: 6, undeclared: 1 },
  issues: [],
  unclaimedFiles: [{ component: "orchestrator", files: ["src/main.ts"] }],
  unattributedReferences: 1,
  utilities: [{ id: "infra", references: 4 }],
  typeDependencies: [{ from: "api", to: "store", count: 2, symbols: ["Job"] }],
  gaps: ["cs root 'tools' is not yet mapped; its code is missing from the component map"],
};

export function fixtureMap(): ResolvedMap {
  return {
    title: "Job orchestrator",
    components: [
      component("operators", "Operators", null, { external: true }),
      component("orchestrator", "Job orchestrator", null, { paths: [""], fileCount: 9 }),
      component("feeds", "Feed service", null, { external: true }),
      component("api", "Operator API", "orchestrator"),
      component("core", "Core", "orchestrator", { fileCount: 3 }),
      component("engine", "Engine", "core"),
      component("support", "Support", "core", { paths: ["src/core/support.ts"], fileCount: 1 }),
      component("store", "Persistence", "orchestrator"),
      component("infra", "Infrastructure", "orchestrator", { utility: true }),
    ],
    interfaces: [
      iface("job-api", "Job API", "orchestrator", ["operators"], {
        kind: "http",
        evidence: ["src/api/routes.ts"],
        evidenceFiles: [{ file: "src/api/routes.ts", component: "api" }],
      }),
      iface("item-feed", "Item feed", "feeds", ["orchestrator"], {
        kind: "http",
        evidence: ["src/core/engine/feed.ts"],
        evidenceFiles: [{ file: "src/core/engine/feed.ts", component: "engine" }],
      }),
      iface("reads", "Read models", "store", ["api", "core"], {
        bind: ["getJob"],
        bindings: [{ symbol: "s1", name: "getJob", file: "src/store/jobs.ts", line: 1, component: "store" }],
        sites: [
          site("src/api/handler.ts", "getJob", "api", "api"),
          site("src/core/engine/run.ts", "getJob", "engine", "core"),
        ],
      }),
      iface("writes", "Job state writes", "store", ["core"], {
        bind: ["saveJob"],
        bindings: [{ symbol: "s2", name: "saveJob", file: "src/store/jobs.ts", line: 5, component: "store" }],
        sites: [
          site("src/api/handler.ts", "saveJob", "api", "api", true),
          site("src/core/engine/run.ts", "saveJob", "engine", "core"),
        ],
        reasons: [{ requirer: "api", reason: "the core owns all job state" }],
      }),
      iface("help", "Helpers", "support", ["engine"], {
        bind: ["helper"],
        bindings: [{ symbol: "s3", name: "helper", file: "src/core/support.ts", line: 1, component: "support" }],
        sites: [site("src/core/engine/run.ts", "helper", "engine", "engine")],
      }),
    ],
    delegations: [
      { interface: "job-api", side: "provided", outer: "orchestrator", inner: "api" },
      { interface: "item-feed", side: "required", outer: "orchestrator", inner: "core" },
      { interface: "item-feed", side: "required", outer: "core", inner: "engine" },
      { interface: "reads", side: "required", outer: "core", inner: "engine" },
      { interface: "writes", side: "required", outer: "core", inner: "engine" },
    ],
    report,
  };
}
