// A small resolved component map: a job orchestrator with an operator API,
// a core with two parts, a persistence facade, a hidden utility and two
// external systems.
import type {
  CallSite,
  CheckReport,
  MapChange,
  ResolvedComponent,
  ResolvedInterface,
  ResolvedMap,
} from "../src/map/types.js";
import type { Flow, Node, Unit } from "../src/api/client.js";

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

/** The fixture map in a review: the engine starts writing through a new
 *  helper of the store, the support helper loses its caller, and the API
 *  gains a write call site. */
export function fixtureChange(): MapChange {
  return {
    baseSha: "base123",
    components: [
      { id: "core", items: 1, files: 1 },
      { id: "engine", items: 1, files: 1 },
      { id: "orchestrator", items: 3, files: 3 },
      { id: "store", items: 1, files: 1 },
    ],
    nodeComponents: { n1: "engine", n5: "engine", n2: "store", n3: "orchestrator", t1: null },
    crossings: [
      {
        interface: "help",
        requirer: "engine",
        status: "removed",
        added: [],
        removed: [site("src/core/engine/run.ts", "helper", "engine", "engine")],
      },
      {
        interface: "writes",
        requirer: "api",
        status: "changed",
        added: [{ ...site("src/api/admin.ts", "saveJob", "api", "api", true), caller: "purge" }],
        removed: [],
      },
    ],
    surfaces: [
      {
        id: "new:store:src/store/cache.ts:warm",
        provider: "store",
        requirers: ["core"],
        symbol: "warm",
        file: "src/store/cache.ts",
        line: 4,
        references: 1,
        where: ["src/core/engine/run.ts:9 (run)"],
        sites: [{ ...site("src/core/engine/run.ts", "warm", "engine", "core"), line: 9, caller: "run" }],
      },
    ],
    delegations: [{ interface: "new:store:src/store/cache.ts:warm", side: "required", outer: "core", inner: "engine" }],
    touched: [{ interface: "reads", reasons: ["body"], symbols: ["getJob"] }],
    unmapped: [{ component: "orchestrator", files: ["src/main.ts"] }],
  };
}

const node = (id: string, file: string, startLine: number, extra: Partial<Node> = {}): Node => ({
  id,
  sessionId: "s1",
  stableId: `s-${id}`,
  label: id,
  file,
  startLine,
  endLine: startLine + 2,
  changeStatus: "changed",
  reviewStatus: "unreviewed",
  reviewedInUnit: null,
  isTest: false,
  ...extra,
});

const NODES: Node[] = [
  node("n1", "src/core/engine/run.ts", 2),
  node("n5", "src/core/engine/run.ts", 20, { reviewStatus: "reviewed-clean" }),
  node("t1", "test/run.test.ts", 1, { isTest: true }),
  node("n2", "src/store/jobs.ts", 1, { reviewStatus: "reviewed-commented" }),
  node("n3", "src/main.ts", 1),
  node("n4", "src/store/jobs.ts", 9, { changeStatus: "unchanged" }),
];
const UNITS: Unit[] = [
  {
    id: "u1",
    sessionId: "s1",
    position: 0,
    label: "Run",
    rationale: "",
    kind: "flow",
    memberStableIds: ["entry"],
    auto: false,
    attached: [{ stableId: "s-t1", parentStableId: "s-n1", reason: "tested-by", counted: true }],
  },
];
const FLOWS = [
  {
    entryStableId: "entry",
    steps: [
      { stableId: "s-n5", nodeId: "n5", changeStatus: "changed" },
      { stableId: "s-n1", nodeId: "n1", changeStatus: "changed" },
    ],
  },
] as unknown as Flow[];

/** Review items of the fixture change: nodes, a plan unit with an attached test, and its flow. */
export function fixtureReview(): { nodes: Node[]; units: Unit[]; flows: Flow[] } {
  return { nodes: NODES, units: UNITS, flows: FLOWS };
}
