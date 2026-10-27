// Resolves interface bind entries to provider symbols. Entries are `name`,
// `Type#member`, `Type#*` (the type and all its members) or
// `path/file.ts:name`; candidates are callable, value and type definitions in
// files the provider's subtree owns.
import type { ReferenceIndex, SymbolDef } from "../graph/references.js";
import type { ComponentTree } from "./ownership.js";
import type { Binding, CheckIssue, MapInterface, MapModel } from "./types.js";

const BINDABLE = new Set(["function", "method", "value", "type"]);
const QUALIFIED = /^(.+\.[A-Za-z0-9]+):(.+)$/;

export interface ResolvedBindings {
  /** interface id → bound symbols, ordered by file and line. */
  bindings: Map<string, Binding[]>;
  /** provider id → symbol → interface id. */
  bySymbol: Map<string, Map<string, string>>;
  issues: CheckIssue[];
}

interface BindEntry {
  text: string;
  file?: string;
  name: string;
  wildcard: boolean;
}

function parseEntry(text: string): BindEntry {
  const qualified = text.match(QUALIFIED);
  const target = qualified ? qualified[2]! : text;
  const wildcard = target.endsWith("#*");
  return {
    text,
    ...(qualified ? { file: qualified[1]! } : {}),
    name: wildcard ? target.slice(0, -2) : target,
    wildcard,
  };
}

function entryMatches(entry: BindEntry, def: SymbolDef): boolean {
  if (entry.file !== undefined && def.file !== entry.file) return false;
  return def.name === entry.name || (entry.wildcard && def.name.startsWith(`${entry.name}#`));
}

/** Definitions a provider can bind, keyed by provider id. */
function candidatesByProvider(model: MapModel, tree: ComponentTree, index: ReferenceIndex) {
  const providers = new Set(model.interfaces.filter((i) => i.kind === undefined).map((i) => i.provider));
  const out = new Map<string, { def: SymbolDef; component: string }[]>([...providers].map((p) => [p, []]));
  for (const def of index.definitions.values()) {
    const component = BINDABLE.has(def.kind) ? tree.ownerOf(def.file) : undefined;
    if (!component) continue;
    for (const provider of providers) {
      if (tree.within(component, provider)) out.get(provider)!.push({ def, component });
    }
  }
  return out;
}

function entryIssue(i: MapInterface, entry: BindEntry, matched: { def: SymbolDef }[]): CheckIssue | undefined {
  if (matched.length === 0) {
    return {
      rule: "binding",
      message: `bind entry '${entry.text}' of interface '${i.id}' matches no symbol in '${i.provider}'`,
    };
  }
  // A wildcard is ambiguous when its type is defined in several files; a name when it is.
  const named = matched.filter((m) => m.def.name === entry.name);
  const files = [...new Set((named.length ? named : matched).map((m) => m.def.file))].sort();
  if (files.length > 1) {
    return {
      rule: "binding",
      message: `bind entry '${entry.text}' of interface '${i.id}' matches symbols in ${files.join(", ")}; qualify it as '${files[0]}:${entry.text}'`,
    };
  }
  return undefined;
}

export function resolveBindings(model: MapModel, tree: ComponentTree, index: ReferenceIndex): ResolvedBindings {
  const candidates = candidatesByProvider(model, tree, index);
  const result: ResolvedBindings = { bindings: new Map(), bySymbol: new Map(), issues: [] };
  for (const i of model.interfaces) {
    if (i.kind !== undefined) continue;
    const owned = result.bySymbol.get(i.provider) ?? new Map<string, string>();
    result.bySymbol.set(i.provider, owned);
    const bound = new Map<string, Binding>();
    for (const entry of i.bind.map(parseEntry)) {
      const matched = candidates.get(i.provider)!.filter((c) => entryMatches(entry, c.def));
      const issue = entryIssue(i, entry, matched);
      if (issue) result.issues.push(issue);
      for (const { def, component } of matched) {
        bound.set(def.symbol, { symbol: def.symbol, name: def.name, file: def.file, line: def.line, component });
      }
    }
    for (const symbol of bound.keys()) claim(result, owned, i, symbol, bound.get(symbol)!.name);
    result.bindings.set(
      i.id,
      [...bound.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    );
  }
  return result;
}

/** Records that interface `i` binds `symbol`; a second interface of the same provider is an issue. */
function claim(result: ResolvedBindings, owned: Map<string, string>, i: MapInterface, symbol: string, name: string) {
  const first = owned.get(symbol);
  if (first === undefined) {
    owned.set(symbol, i.id);
    return;
  }
  result.issues.push({
    rule: "binding",
    message: `symbol '${name}' of '${i.provider}' is bound by both '${first}' and '${i.id}'`,
  });
}
