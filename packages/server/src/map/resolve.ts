// Attributes every cross-component reference to the level where it crosses
// between siblings: a call site of the interface that binds its symbol, an
// uncovered reference, a utility exemption or violation, an unattributed
// reference from a parent's own files, or a type-only dependency.
import type { ReferenceIndex, SymbolDef, SymbolRef } from "../graph/references.js";
import type { ResolvedBindings } from "./bindings.js";
import type { ComponentTree } from "./ownership.js";
import type { CallSite, CheckIssue, CheckReport } from "./types.js";

const MAX_SAMPLES = 5;
const MAX_TYPE_SYMBOLS = 8;

interface Uncovered {
  provider: string;
  def: SymbolDef;
  from: Set<string>;
  where: string[];
  count: number;
}

export interface ReferenceResolution {
  sites: Map<string, CallSite[]>;
  references: number;
  uncovered: Uncovered[];
  utilityRefs: Map<string, number>;
  utilityViolations: Map<string, { utility: string; target: string; count: number; where: string[] }>;
  unattributed: number;
  typeDependencies: CheckReport["typeDependencies"];
}

const at = (r: SymbolRef) => `${r.file}:${r.line} (${r.caller})`;

class Resolver {
  readonly out: ReferenceResolution = {
    sites: new Map(),
    references: 0,
    uncovered: [],
    utilityRefs: new Map(),
    utilityViolations: new Map(),
    unattributed: 0,
    typeDependencies: [],
  };
  private uncoveredByKey = new Map<string, Uncovered>();
  private types = new Map<string, { from: string; to: string; count: number; symbols: Set<string> }>();

  constructor(
    private tree: ComponentTree,
    private bound: ResolvedBindings,
    private declared: Map<string, Set<string>>,
  ) {}

  add(ref: SymbolRef, def: SymbolDef): void {
    const from = this.tree.ownerOf(ref.file);
    const to = this.tree.ownerOf(def.file);
    if (!from || !to || from === to) return;
    if (this.tree.get(to)!.utility) {
      this.out.utilityRefs.set(to, (this.out.utilityRefs.get(to) ?? 0) + 1);
      return;
    }
    const fromUtility = this.tree.get(from)!.utility;
    if (ref.typeOnly) {
      if (!fromUtility) this.typeDependency(from, to, def);
      return;
    }
    if (fromUtility) return this.violation(from, to, ref);
    const pair = this.siblings(from, to);
    if (!pair) {
      this.out.unattributed++;
      return;
    }
    this.out.references++;
    this.site(pair.a, pair.b, from, ref, def);
  }

  finish(): ReferenceResolution {
    this.out.uncovered = [...this.uncoveredByKey.values()];
    this.out.typeDependencies = [...this.types.values()].map((t) => ({
      ...t,
      symbols: [...t.symbols].slice(0, MAX_TYPE_SYMBOLS),
    }));
    return this.out;
  }

  private siblings(from: string, to: string): { a: string; b: string } | undefined {
    const lca = this.tree.lca(from, to);
    const a = this.tree.childToward(lca, from);
    const b = this.tree.childToward(lca, to);
    return a && b ? { a, b } : undefined;
  }

  private site(requirer: string, provider: string, component: string, ref: SymbolRef, def: SymbolDef): void {
    const iface = this.bound.bySymbol.get(provider)?.get(def.symbol);
    if (!iface) return this.uncoveredRef(provider, requirer, ref, def);
    const undeclared = !this.declared.get(iface)!.has(requirer);
    const site = {
      file: ref.file,
      line: ref.line,
      caller: ref.caller,
      symbol: def.name,
      component,
      requirer,
      undeclared,
    };
    this.out.sites.set(iface, [...(this.out.sites.get(iface) ?? []), site]);
  }

  private uncoveredRef(provider: string, requirer: string, ref: SymbolRef, def: SymbolDef): void {
    const key = `${provider}\0${def.symbol}`;
    const entry = this.uncoveredByKey.get(key) ?? { provider, def, from: new Set<string>(), where: [], count: 0 };
    entry.from.add(requirer);
    entry.count++;
    entry.where.push(at(ref));
    this.uncoveredByKey.set(key, entry);
  }

  private violation(utility: string, to: string, ref: SymbolRef): void {
    const target = this.siblings(utility, to)?.b ?? to;
    const key = `${utility}\0${target}`;
    const entry = this.out.utilityViolations.get(key) ?? { utility, target, count: 0, where: [] };
    entry.count++;
    entry.where.push(at(ref));
    this.out.utilityViolations.set(key, entry);
  }

  private typeDependency(from: string, to: string, def: SymbolDef): void {
    const pair = this.siblings(from, to);
    if (!pair) return;
    const key = `${pair.a}\0${pair.b}`;
    const entry = this.types.get(key) ?? { from: pair.a, to: pair.b, count: 0, symbols: new Set<string>() };
    entry.count++;
    entry.symbols.add(def.name);
    this.types.set(key, entry);
  }
}

export function resolveReferences(
  index: ReferenceIndex,
  tree: ComponentTree,
  bound: ResolvedBindings,
  declared: Map<string, Set<string>>,
): ReferenceResolution {
  const resolver = new Resolver(tree, bound, declared);
  for (const ref of index.references) resolver.add(ref, index.definitions.get(ref.symbol)!);
  return resolver.finish();
}

export function referenceIssues(res: ReferenceResolution): CheckIssue[] {
  const uncovered = res.uncovered.map((u) => ({
    rule: "coverage" as const,
    message:
      `'${u.provider}' symbol '${u.def.name}' (${u.def.file}:${u.def.line}) is used by ${[...u.from].sort().join(", ")} ` +
      `but bound by no interface of '${u.provider}' (${u.count} reference${u.count === 1 ? "" : "s"})`,
    where: u.where.slice(0, MAX_SAMPLES),
  }));
  const violations = [...res.utilityViolations.values()].map((v) => ({
    rule: "utility" as const,
    message:
      `utility '${v.utility}' references visible component '${v.target}' (${v.count} reference${v.count === 1 ? "" : "s"}); ` +
      `utilities may not depend on visible components`,
    where: v.where.slice(0, MAX_SAMPLES),
  }));
  return [...uncovered, ...violations];
}
