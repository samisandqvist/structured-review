// Symbol-level reference index for the component map: named definitions in
// mapped languages (TypeScript/JavaScript and Python) and the cross-file
// references between them, each with its enclosing caller and whether it only
// names a type. Field accesses, parameters and other non-callable descriptors
// are left out; imports are not references.
import { isTestFile } from "../util.js";

export type SymbolKind = "function" | "method" | "value" | "field" | "type" | "module" | "other";

export interface SymbolDef {
  symbol: string;
  file: string;
  line: number;
  name: string;
  kind: SymbolKind;
}
export interface SymbolRef {
  symbol: string;
  file: string;
  line: number;
  caller: string;
  typeOnly: boolean;
}
export interface BarrelExport {
  file: string;
  exports: { from: string; names: string[] }[];
}
export interface ReferenceIndex {
  files: string[];
  definitions: Map<string, SymbolDef>;
  references: SymbolRef[];
  implementations: Map<string, string[]>;
  barrels: BarrelExport[];
  gaps: string[];
}

export interface IndexedDocument {
  file: string;
  occurrences: { range?: number[]; enclosingRange?: number[]; symbol?: string; symbolRoles?: number }[];
  symbols: { symbol?: string; relationships?: { symbol?: string; isImplementation?: boolean }[] }[];
}
type ReadSource = (file: string) => string | undefined;
type Occurrence = IndexedDocument["occurrences"][number];

const ROLE_DEFINITION = 0x1;
const ROLE_IMPORT = 0x2;
const MAPPED_FILE = /\.([cm]?[jt]sx?|py)$/;
const BARREL_FILE = /(^|\/)(index\.[cm]?[jt]sx?|__init__\.py)$/;
const REFERENCED_KINDS = new Set<SymbolKind>(["function", "method", "value", "type"]);

const isMappedFile = (file: string) => MAPPED_FILE.test(file) && !isTestFile(file);

/** Descriptor after the file segment, without the trailing suffix:
 *  `` src/`a.ts`/Registry#getAgent(). `` → `Registry#getAgent`. */
export function symbolName(symbol: string): string {
  if (symbol.startsWith("local ")) return symbol;
  const at = symbol.lastIndexOf("`/");
  const desc = at < 0 ? symbol : symbol.slice(at + 2);
  return desc.replace(/\([^)]*\)\.$/, "").replace(/[.#]$/, "");
}

export function symbolKind(symbol: string): SymbolKind {
  if (symbol.startsWith("local ")) return "other";
  if (symbol.endsWith("/")) return "module";
  if (symbol.endsWith("#")) return "type";
  const member = symbolName(symbol).includes("#");
  if (symbol.endsWith(").")) return member ? "method" : "function";
  if (symbol.endsWith(".")) return member ? "field" : "value";
  return "other";
}

const line1 = (o: Occurrence) => (o.range?.[0] ?? 0) + 1;
const hasRole = (o: Occurrence, role: number) => ((o.symbolRoles ?? 0) & role) !== 0;

function collectDefinitions(documents: IndexedDocument[]): Map<string, SymbolDef> {
  const definitions = new Map<string, SymbolDef>();
  for (const doc of documents) {
    for (const o of doc.occurrences) {
      if (!o.symbol || !hasRole(o, ROLE_DEFINITION) || o.symbol.startsWith("local ") || definitions.has(o.symbol)) {
        continue;
      }
      definitions.set(o.symbol, {
        symbol: o.symbol,
        file: doc.file,
        line: line1(o),
        name: symbolName(o.symbol),
        kind: symbolKind(o.symbol),
      });
    }
  }
  return definitions;
}

interface CallerSpan {
  name: string;
  start: number;
  end: number;
}

/** Named definitions with a body in this document, innermost first. */
function callerSpans(doc: IndexedDocument): CallerSpan[] {
  const spans: CallerSpan[] = [];
  for (const o of doc.occurrences) {
    const r = o.enclosingRange;
    if (!o.symbol || !r || !hasRole(o, ROLE_DEFINITION) || o.symbol.endsWith("/") || o.symbol.startsWith("local ")) {
      continue;
    }
    spans.push({ name: symbolName(o.symbol), start: r[0]!, end: r.length === 4 ? r[2]! : r[0]! });
  }
  return spans.sort((a, b) => a.end - a.start - (b.end - b.start));
}

/** A type reference that constructs or calls: `new Foo` or `Foo(`. */
function constructs(lines: string[] | undefined, o: Occurrence): boolean {
  const r = o.range;
  const text = r && lines?.[r[0]!];
  if (!r || !text) return false;
  const end = r.length === 4 ? r[3]! : r[2]!;
  return text[end] === "(" || /\bnew\s+$/.test(text.slice(0, r[1]));
}

function documentReferences(
  doc: IndexedDocument,
  definitions: Map<string, SymbolDef>,
  readSource: ReadSource,
): SymbolRef[] {
  const spans = callerSpans(doc);
  let lines: string[] | undefined | null = null;
  const refs: SymbolRef[] = [];
  for (const o of doc.occurrences) {
    if (!o.symbol || hasRole(o, ROLE_DEFINITION) || hasRole(o, ROLE_IMPORT)) continue;
    const def = definitions.get(o.symbol);
    if (!def || def.file === doc.file || !REFERENCED_KINDS.has(def.kind)) continue;
    const line = o.range?.[0] ?? 0;
    let typeOnly = false;
    if (def.kind === "type") {
      if (lines === null) lines = readSource(doc.file)?.split("\n");
      typeOnly = !constructs(lines, o);
    }
    const caller = spans.find((s) => line >= s.start && line <= s.end)?.name ?? "(module)";
    refs.push({ symbol: o.symbol, file: doc.file, line: line + 1, caller, typeOnly });
  }
  return refs;
}

function collectImplementations(documents: IndexedDocument[]): Map<string, string[]> {
  const implementations = new Map<string, string[]>();
  for (const doc of documents) {
    for (const info of doc.symbols) {
      for (const rel of info.relationships ?? []) {
        if (!rel.isImplementation || !rel.symbol || !info.symbol) continue;
        implementations.set(rel.symbol, [...(implementations.get(rel.symbol) ?? []), info.symbol]);
      }
    }
  }
  return implementations;
}

function barrelExports(doc: IndexedDocument, definitions: Map<string, SymbolDef>): BarrelExport | undefined {
  const byFile = new Map<string, string[]>();
  for (const o of doc.occurrences) {
    if (!o.symbol || hasRole(o, ROLE_DEFINITION)) continue;
    const def = definitions.get(o.symbol);
    if (!def || def.file === doc.file || def.kind === "module") continue;
    const names = byFile.get(def.file) ?? [];
    if (!names.includes(def.name)) names.push(def.name);
    byFile.set(def.file, names);
  }
  if (byFile.size === 0) return undefined;
  const exports = [...byFile].map(([from, names]) => ({ from, names })).sort((a, b) => a.from.localeCompare(b.from));
  return { file: doc.file, exports };
}

export function buildReferenceIndex(
  documents: IndexedDocument[],
  readSource: ReadSource,
  gaps: string[],
): ReferenceIndex {
  const mapped = documents.filter((d) => isMappedFile(d.file));
  const definitions = collectDefinitions(mapped);
  return {
    files: mapped.map((d) => d.file).sort(),
    definitions,
    references: mapped.flatMap((d) => documentReferences(d, definitions, readSource)),
    implementations: collectImplementations(mapped),
    barrels: mapped
      .filter((d) => BARREL_FILE.test(d.file))
      .map((d) => barrelExports(d, definitions))
      .filter((b): b is BarrelExport => b !== undefined),
    gaps,
  };
}
