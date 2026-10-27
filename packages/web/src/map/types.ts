// The resolved component map as served by GET /api/sessions/:id/map (mirrors
// the hub's map types; the web package never imports server code).

interface MapComponent {
  id: string;
  name: string;
  parent: string | null;
  meaning: string;
  /** Repository-relative path prefixes (trailing `/`), files or globs; `""` claims everything. */
  paths: string[];
  external: boolean;
  utility: boolean;
}

interface MapInterface {
  id: string;
  name: string;
  provider: string;
  requirers: string[];
  meaning: string;
  /** In-process: provider symbols as `name`, `Type#member`, `Type#*` or `path/file.ts:name`. */
  bind: string[];
  /** Set for a cross-process interface (`http`, `mcp`, `webhook`, `queue`, `database`, …). */
  kind?: string;
  /** Cross-process: files that realize or use the interface. */
  evidence: string[];
}

interface UndeclaredUse {
  interface: string;
  requirer: string;
  reason: string;
}

interface MapModel {
  title: string;
  components: MapComponent[];
  interfaces: MapInterface[];
  undeclared: UndeclaredUse[];
}

type CheckRule = "model" | "coverage" | "binding" | "requirer" | "undeclared" | "evidence" | "utility";

interface CheckIssue {
  rule: CheckRule;
  message: string;
  /** Sample locations, `file:line (caller)`. */
  where?: string[];
}

interface Binding {
  symbol: string;
  name: string;
  file: string;
  line: number;
  component: string;
}

export interface CallSite {
  file: string;
  line: number;
  caller: string;
  symbol: string;
  component: string;
  requirer: string;
  undeclared: boolean;
}

interface Delegation {
  interface: string;
  side: "provided" | "required";
  outer: string;
  inner: string;
}

export interface ResolvedInterface extends MapInterface {
  bindings: Binding[];
  sites: CallSite[];
  evidenceFiles: { file: string; component: string }[];
  reasons: { requirer: string; reason: string }[];
}

export interface ResolvedComponent extends MapComponent {
  fileCount: number;
}

export interface CheckReport {
  /** True when no issue was found (fidelity rules 1–5 and the model's structure). */
  ok: boolean;
  coverage: { references: number; covered: number; undeclared: number };
  issues: CheckIssue[];
  unclaimedFiles: { component: string | null; files: string[] }[];
  unattributedReferences: number;
  utilities: { id: string; references: number }[];
  typeDependencies: { from: string; to: string; count: number; symbols: string[] }[];
  gaps: string[];
}

export type ChangeStatus = "new" | "removed" | "changed";

interface CrossingChange {
  interface: string;
  requirer: string;
  status: ChangeStatus;
  added: CallSite[];
  removed: CallSite[];
}

interface NewSurface {
  id: string;
  provider: string;
  requirers: string[];
  symbol: string;
  file: string;
  line: number;
  references: number;
  where: string[];
  sites: CallSite[];
}

interface TouchedContract {
  interface: string;
  reasons: ("body" | "binding-lost" | "evidence")[];
  symbols: string[];
}

/** A review's change on a map built from its base (see the hub's map/change.ts). */
export interface MapChange {
  baseSha: string;
  components: { id: string; items: number; files: number }[];
  nodeComponents: Record<string, string | null>;
  crossings: CrossingChange[];
  surfaces: NewSurface[];
  delegations: Delegation[];
  touched: TouchedContract[];
  unmapped: { component: string | null; files: string[] }[];
}

export interface ResolvedMap {
  title: string;
  components: ResolvedComponent[];
  interfaces: ResolvedInterface[];
  delegations: Delegation[];
  report: CheckReport;
  change?: MapChange;
}

export interface StoredMapResponse {
  model: MapModel;
  map: ResolvedMap;
  headSha: string;
  createdAt: number;
  stale?: boolean;
  staleReason?: "head-moved" | "working-tree-changed";
}
