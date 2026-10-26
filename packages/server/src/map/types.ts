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

export interface UndeclaredUse {
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

export type CheckRule = "model" | "coverage" | "binding" | "requirer" | "undeclared" | "evidence" | "utility";

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

export interface ResolvedMap {
  title: string;
  components: ResolvedComponent[];
  interfaces: ResolvedInterface[];
  delegations: Delegation[];
  report: CheckReport;
}
