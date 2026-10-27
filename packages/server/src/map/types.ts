// Component map types: the model an LLM writes, and the resolved map the hub
// stores and serves (bindings, call sites, delegation and the check report).

export interface MapComponent {
  id: string;
  name: string;
  parent: string | null;
  meaning: string;
  /** Repository-relative path prefixes (trailing `/`), files or globs; `""` claims everything. */
  paths: string[];
  external: boolean;
  utility: boolean;
}

export interface MapInterface {
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

export interface MapModel {
  title: string;
  components: MapComponent[];
  interfaces: MapInterface[];
  undeclared: UndeclaredUse[];
}

type CheckRule = "model" | "coverage" | "binding" | "requirer" | "undeclared" | "evidence" | "utility";

export interface CheckIssue {
  rule: CheckRule;
  message: string;
  /** Sample locations, `file:line (caller)`. */
  where?: string[];
}

export interface Binding {
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

export interface Delegation {
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

interface ResolvedComponent extends MapComponent {
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

/** A crossing (requirer, interface) whose call sites differ between base and head. */
export interface CrossingChange {
  interface: string;
  requirer: string;
  status: "new" | "removed" | "changed";
  added: CallSite[];
  removed: CallSite[];
}

/** A head reference across components to a symbol no interface of its provider binds. */
export interface NewSurface {
  provider: string;
  requirers: string[];
  symbol: string;
  file: string;
  line: number;
  references: number;
  /** Sample locations, `file:line (caller)`. */
  where: string[];
}

export interface TouchedContract {
  interface: string;
  reasons: ("body" | "binding-lost" | "evidence")[];
  symbols: string[];
}

/** A review's change on a map built from its base. */
export interface MapChange {
  baseSha: string;
  /** Components owning changed review items or changed files, ancestors included. */
  components: { id: string; items: number; files: number }[];
  /** Changed review node id → the deepest component whose paths claim its file (null: none). */
  nodeComponents: Record<string, string | null>;
  crossings: CrossingChange[];
  surfaces: NewSurface[];
  touched: TouchedContract[];
  /** Changed files no leaf claims: owned by no component (null) or by a component with parts. */
  unmapped: { component: string | null; files: string[] }[];
}

export interface ResolvedMap {
  title: string;
  components: ResolvedComponent[];
  interfaces: ResolvedInterface[];
  delegations: Delegation[];
  report: CheckReport;
  /** Set on a review session's map: the change between its base and the head. */
  change?: MapChange;
}
