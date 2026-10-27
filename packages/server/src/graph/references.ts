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
  /** Last line of the definition's body, when the indexer records it. */
  endLine?: number;
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

/** The descriptors of a SCIP symbol: everything after its four header fields
 *  (scheme, manager, package, version); a doubled space is an escaped space. */
function descriptors(symbol: string): string {
  let fields = 0;
  for (let i = 0; i < symbol.length; i++) {
    if (symbol[i] !== " ") continue;
    if (symbol[i + 1] === " ") {
      i++;
      continue;
    }
    if (++fields === 4) return symbol.slice(i + 1);
  }
  return symbol;
}

/** The symbol's name inside its file or module, without the trailing suffix:
 *  `` src/`a.ts`/Registry#getAgent(). `` → `Registry#getAgent`, `httpie/__version__.` → `__version__`. */
export function symbolName(symbol: string): string {
  if (symbol.startsWith("local ")) return symbol;
  const desc = descriptors(symbol);
  let quoted = false;
  let start = 0;
  for (let i = 0; i < desc.length; i++) {
    if (desc[i] === "`") quoted = !quoted;
    else if (desc[i] === "/" && !quoted) start = i + 1;
  }
  return desc
    .slice(start)
    .replace(/\([^)]*\)\.$/, "")
    .replace(/[.#]$/, "");
}

export function symbolKind(symbol: string): SymbolKind {
  if (symbol.startsWith("local ")) return "other";
  if (symbol.endsWith("/")) return "module";
  if (symbol.endsWith("#")) return "type";
  const name = symbolName(symbol);
  // Object-literal and parameter properties (`fn().(arg)typeLiteral0:url`) are data members.
  if (/[(:]/.test(name)) return symbol.endsWith(".") ? "field" : "other";
  const member = name.includes("#");
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
      const end = o.enclosingRange && o.enclosingRange.length === 4 ? o.enclosingRange[2]! + 1 : undefined;
      definitions.set(o.symbol, {
        symbol: o.symbol,
        file: doc.file,
        line: line1(o),
        name: symbolName(o.symbol),
        kind: symbolKind(o.symbol),
        ...(end ? { endLine: end } : {}),
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

/** Text before a reference that marks a type position (annotations, generics, heritage, casts). */
const TYPE_POSITION = /(?::|->|<|\||&|\bextends|\bimplements|\bas|\bsatisfies|\bkeyof|\btypeof)\s*$/;
/** Text before and after a reference that marks a value position (arguments, list items, assignment, return). */
const VALUE_BEFORE = /(?:[[(,=]|\breturn|\bthrow|\binstanceof|\bnew)\s*$/;
const VALUE_AFTER = /^\s*(?:[(.]|[,)\];]|$)/;

const CLOSERS = new Set(["]", ")", ">"]);
const OPENERS = new Set(["[", "(", "<"]);

/** Whether text ends inside type arguments: an open `<` right after a name
 *  (`Map<string, `, `cast<A, `), or an open `[` whose subscripted name sits
 *  in a type position (`x: Union[List[str], `). An open `(` is a call. */
function inTypeArguments(before: string): boolean {
  let depth = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    const ch = before[i]!;
    if (CLOSERS.has(ch)) depth++;
    else if (OPENERS.has(ch) && depth > 0) depth--;
    else if (OPENERS.has(ch)) {
      if (ch === "(") return false;
      const head = before.slice(0, i);
      if (ch === "<") return /[\w$]$/.test(head);
      const outer = head.replace(/[\w.$]+\s*$/, "");
      return TYPE_POSITION.test(outer) || inTypeArguments(outer);
    }
  }
  return false;
}

/** Whether a reference to a type uses it as a value: `new Foo`, `Foo(`, `Foo.x`,
 *  `x instanceof Foo`, `register(Foo)`, `[a, Foo]`. Annotations and generic
 *  arguments stay type-only. Without source text a type reference is type-only. */
function valueUse(lines: string[] | undefined, o: Occurrence): boolean {
  const r = o.range!;
  const text = lines?.[r[0]!];
  if (!text) return false;
  const before = text.slice(0, r[1]);
  const after = text.slice(r.length === 4 ? r[3] : r[2]);
  if (/^\s*[(.]/.test(after) || /\b(?:new|instanceof)\s*$/.test(before)) return true;
  if (TYPE_POSITION.test(before) || inTypeArguments(before)) return false;
  return VALUE_BEFORE.test(before) && VALUE_AFTER.test(after);
}

const TS_IMPORT = /^(?:import\s*[\w*{"'$]|export\s+(?:\*|\{|type\s+\{))/;
const PY_IMPORT = /^(?:import|from)\s/;

/** Lines (0-based) of one statement starting at `start`: until braces or parentheses balance. */
function statementEnd(lines: string[], start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    const text = lines[i]!;
    depth += text.split(open).length - text.split(close).length;
    if (depth <= 0 && !text.trimEnd().endsWith("\\")) return i;
  }
  return lines.length - 1;
}

/** Lines holding import statements and `export … from` re-exports: names there are not references. */
export function importLines(source: string, file: string): Set<number> {
  const python = file.endsWith(".py");
  const lines = source.split("\n");
  const out = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.trimStart();
    if (!(python ? PY_IMPORT : TS_IMPORT).test(text)) continue;
    const end = python ? statementEnd(lines, i, "(", ")") : statementEnd(lines, i, "{", "}");
    const statement = lines.slice(i, end + 1).join("\n");
    if (!python && text.startsWith("export") && !/\bfrom\s*["']/.test(statement)) continue;
    for (let j = i; j <= end; j++) out.add(j);
    i = end;
  }
  return out;
}

/** The definition an occurrence references across files, or undefined for definitions, imports and same-file uses. */
function referencedDefinition(
  o: Occurrence,
  file: string,
  imports: Set<number>,
  definitions: Map<string, SymbolDef>,
): SymbolDef | undefined {
  if (!o.symbol || hasRole(o, ROLE_DEFINITION) || hasRole(o, ROLE_IMPORT)) return undefined;
  if (imports.has(o.range?.[0] ?? -1)) return undefined;
  const def = definitions.get(o.symbol);
  return def && def.file !== file && REFERENCED_KINDS.has(def.kind) ? def : undefined;
}

function documentReferences(
  doc: IndexedDocument,
  definitions: Map<string, SymbolDef>,
  readSource: ReadSource,
): SymbolRef[] {
  const spans = callerSpans(doc);
  const source = readSource(doc.file);
  const lines = source?.split("\n");
  const imports = source === undefined ? new Set<number>() : importLines(source, doc.file);
  const refs: SymbolRef[] = [];
  for (const o of doc.occurrences) {
    const def = referencedDefinition(o, doc.file, imports, definitions);
    if (!def) continue;
    const line = o.range?.[0] ?? 0;
    const typeOnly = def.kind === "type" && !valueUse(lines, o);
    const caller = spans.find((s) => line >= s.start && line <= s.end)?.name ?? "(module)";
    refs.push({ symbol: def.symbol, file: doc.file, line: line + 1, caller, typeOnly });
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
    if (!def || def.file === doc.file || !REFERENCED_KINDS.has(def.kind)) continue;
    const names = byFile.get(def.file) ?? [];
    if (!names.includes(def.name)) names.push(def.name);
    byFile.set(def.file, names);
  }
  if (byFile.size === 0) return undefined;
  const exports = [...byFile].map(([from, names]) => ({ from, names })).sort((a, b) => a.from.localeCompare(b.from));
  return { file: doc.file, exports };
}

/** One gap line per directory holding tracked, mapped-language sources the index does not contain. */
export function unindexedGaps(tracked: string[], indexed: string[]): string[] {
  const known = new Set(indexed);
  const groups = new Map<string, number>();
  for (const file of tracked) {
    if (!isMappedFile(file) || known.has(file)) continue;
    const dir = file.includes("/") ? `${file.slice(0, file.lastIndexOf("/"))}/` : ".";
    const language = file.endsWith(".py") ? "Python" : "TypeScript/JavaScript";
    const key = `${dir}\0${language}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, n]) => {
      const [dir, language] = key.split("\0") as [string, string];
      const files = n === 1 ? `1 ${language} file in ${dir} is` : `${n} ${language} files in ${dir} are`;
      return `${files} not in the index (outside every indexed project); the map does not cover ${n === 1 ? "it" : "them"}`;
    });
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
