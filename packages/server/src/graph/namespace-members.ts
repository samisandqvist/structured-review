// scip-typescript records the member in `import * as ns from "./mod.js";
// ns.fn()` as a `local N` symbol, which hides the call from the graph. Such a
// local directly follows the module occurrence (`ns`, separated by one dot on
// the same line); its name is read from the source line and resolved through
// the names the module defines or re-exports, following `export *` chains.

export interface ScipOccurrenceLike {
  range?: number[];
  symbol?: string;
  symbolRoles?: number;
}
export interface NamespaceDocument {
  file: string;
  occurrences: ScipOccurrenceLike[];
}
type ReadSource = (file: string) => string | undefined;

const isLocal = (symbol: string) => symbol.startsWith("local ");
const isModule = (symbol: string) => symbol.endsWith("/") && !isLocal(symbol);

/** The repository path a module symbol names: `` src/store/`index.ts`/ `` → `src/store/index.ts`. */
function modulePath(symbol: string): string | undefined {
  const m = symbol.match(/ ([^ ]*)`([^`]+)`\/$/);
  return m ? `${m[1]}${m[2]}` : undefined;
}

/** Descriptor after the file segment: `` …`jobs.ts`/getJob(). `` → `getJob().`. */
const descriptor = (symbol: string) => symbol.slice(symbol.lastIndexOf("`/") + 2);

/** A named occurrence on one source line. */
interface Span {
  occurrence: ScipOccurrenceLike;
  symbol: string;
  line: number;
  start: number;
  end: number;
}

/** Occurrences with a symbol and a single-line range, in source order. */
function spans(doc: NamespaceDocument): Span[] {
  const out: Span[] = [];
  for (const occurrence of doc.occurrences) {
    const r = occurrence.range ?? [];
    const end = r.length === 4 && r[0] === r[2] ? r[3] : r.length === 3 ? r[2] : undefined;
    if (!occurrence.symbol || end === undefined) continue;
    out.push({ occurrence, symbol: occurrence.symbol, line: r[0]!, start: r[1]!, end });
  }
  return out.sort((a, b) => a.line - b.line || a.start - b.start);
}

class ModuleExports {
  private byFile = new Map<string, NamespaceDocument>();
  private lines = new Map<string, string[] | undefined>();

  constructor(
    documents: NamespaceDocument[],
    private readSource: ReadSource,
  ) {
    for (const d of documents) this.byFile.set(d.file, d);
  }

  /** The document for a module symbol: exact path, else the one document whose path ends with it (multi-root repos). */
  document(moduleSymbol: string): NamespaceDocument | undefined {
    const path = modulePath(moduleSymbol);
    if (!path) return undefined;
    const exact = this.byFile.get(path);
    if (exact) return exact;
    const matches = [...this.byFile.keys()].filter((f) => f.endsWith(`/${path}`));
    return matches.length === 1 ? this.byFile.get(matches[0]!) : undefined;
  }

  sourceLines(file: string): string[] | undefined {
    if (!this.lines.has(file)) this.lines.set(file, this.readSource(file)?.split("\n"));
    return this.lines.get(file);
  }

  /** The symbol `name` resolves to in a module, or undefined. */
  resolve(moduleSymbol: string, name: string, seen = new Set<string>()): string | undefined {
    const doc = this.document(moduleSymbol);
    if (!doc || seen.has(doc.file)) return undefined;
    seen.add(doc.file);
    const wanted = new Set([`${name}().`, `${name}.`, `${name}#`]);
    const own = spans(doc).find((o) => !isLocal(o.symbol) && wanted.has(descriptor(o.symbol)));
    if (own) return own.symbol;
    for (const next of this.starExports(doc)) {
      const found = this.resolve(next, name, seen);
      if (found) return found;
    }
    return undefined;
  }

  /** Modules named on `export * from …` lines of a document. */
  private starExports(doc: NamespaceDocument): string[] {
    const lines = this.sourceLines(doc.file) ?? [];
    return spans(doc)
      .filter((o) => isModule(o.symbol) && /^\s*export\s+\*/.test(lines[o.line]!))
      .map((o) => o.symbol);
  }
}

/** The member name when `b` is `ns.<member>` right after the module occurrence `a`. */
function memberName(a: Span, b: Span, lines: string[]): string | undefined {
  const text = lines[b.line] ?? "";
  if (a.line !== b.line || a.end + 1 !== b.start || text[a.end] !== ".") return undefined;
  return text.slice(b.start, b.end);
}

/** Rewrites resolvable namespace member locals in place; returns how many were resolved. */
export function resolveNamespaceMembers(documents: NamespaceDocument[], readSource: ReadSource): number {
  const modules = new ModuleExports(documents, readSource);
  let resolved = 0;
  for (const doc of documents) {
    const ordered = spans(doc);
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1]!;
      const occ = ordered[i]!;
      if (!isLocal(occ.symbol) || !isModule(prev.symbol)) continue;
      const lines = modules.sourceLines(doc.file) ?? [];
      const symbol = modules.resolve(prev.symbol, memberName(prev, occ, lines) ?? "");
      if (!symbol) continue;
      occ.occurrence.symbol = symbol;
      resolved++;
    }
  }
  return resolved;
}
