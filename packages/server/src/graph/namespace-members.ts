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
function descriptor(symbol: string): string {
  const at = symbol.lastIndexOf("`/");
  return at < 0 ? symbol : symbol.slice(at + 2);
}

function lineCol(o: ScipOccurrenceLike): { line: number; start: number; end: number } | undefined {
  const r = o.range;
  if (!r || r.length < 3) return undefined;
  const end = r.length === 4 ? (r[0] === r[2] ? r[3] : undefined) : r[2];
  if (end === undefined) return undefined;
  return { line: r[0]!, start: r[1]!, end };
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
    const own = doc.occurrences.find((o) => o.symbol && !isLocal(o.symbol) && wanted.has(descriptor(o.symbol)));
    if (own?.symbol) return own.symbol;
    for (const next of this.starExports(doc)) {
      const found = this.resolve(next, name, seen);
      if (found) return found;
    }
    return undefined;
  }

  /** Modules named on `export * from …` lines of a document. */
  private starExports(doc: NamespaceDocument): string[] {
    const lines = this.sourceLines(doc.file);
    if (!lines) return [];
    return doc.occurrences
      .filter((o) => o.symbol && isModule(o.symbol) && /^\s*export\s+\*/.test(lines[o.range?.[0] ?? -1] ?? ""))
      .map((o) => o.symbol!);
  }
}

function sortedOccurrences(doc: NamespaceDocument): ScipOccurrenceLike[] {
  return [...doc.occurrences].sort(
    (a, b) => (a.range?.[0] ?? 0) - (b.range?.[0] ?? 0) || (a.range?.[1] ?? 0) - (b.range?.[1] ?? 0),
  );
}

/** The member name when `occ` is `ns.<member>` right after the module occurrence `prev`. */
function memberName(prev: ScipOccurrenceLike, occ: ScipOccurrenceLike, lines: string[]): string | undefined {
  const a = lineCol(prev);
  const b = lineCol(occ);
  if (!a || !b || a.line !== b.line || a.end + 1 !== b.start) return undefined;
  const text = lines[b.line];
  if (text?.[a.end] !== ".") return undefined;
  return text.slice(b.start, b.end) || undefined;
}

/** Rewrites resolvable namespace member locals in place; returns how many were resolved. */
export function resolveNamespaceMembers(documents: NamespaceDocument[], readSource: ReadSource): number {
  const modules = new ModuleExports(documents, readSource);
  let resolved = 0;
  for (const doc of documents) {
    const occurrences = sortedOccurrences(doc);
    for (let i = 1; i < occurrences.length; i++) {
      const prev = occurrences[i - 1]!;
      const occ = occurrences[i]!;
      if (!occ.symbol || !isLocal(occ.symbol) || !prev.symbol || !isModule(prev.symbol)) continue;
      const lines = modules.sourceLines(doc.file);
      const name = lines && memberName(prev, occ, lines);
      const symbol = name && modules.resolve(prev.symbol, name);
      if (!symbol) continue;
      occ.symbol = symbol;
      resolved++;
    }
  }
  return resolved;
}
