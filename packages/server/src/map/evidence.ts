// Evidence an LLM reasons from when it writes a component model: the
// directory tree, candidate components (the scope's direct entries), the
// reference matrix between them, boundary surfaces grouped by the set of
// consumers, and explicit signals (implementations, barrels, header comments,
// entry points, registrations). `--within` narrows everything to a sub-tree so
// large codebases are modelled level by level.
import type { BarrelExport, ReferenceIndex, SymbolDef } from "../graph/references.js";
import { symbolName } from "../graph/references.js";
import type { ComponentMap } from "../component-map.js";
import { entryPointReason, headerComment, registrations } from "./signals.js";

export interface EvidenceOptions {
  within?: string;
  full: boolean;
}

export interface EvidenceContext {
  readSource: (file: string) => string | undefined;
  roots: { language: string; root: string }[];
  manifest?: ComponentMap;
}

export interface MapEvidence {
  scope: string;
  full: boolean;
  tree: { path: string; files: number }[];
  roots: { language: string; root: string }[];
  manifest?: { id: string; paths: string[]; description?: string }[];
  candidates: { id: string; files: number }[];
  matrix: { from: string; to: string; references: number }[];
  surfaces: { candidate: string; symbols: number; groups: { usedBy: string[]; symbols: string[] }[] }[];
  signals: {
    implementations: { type: string; file: string; implementations: string[] }[];
    barrels: BarrelExport[];
    headers: { file: string; comment: string }[];
    entryPoints: { file: string; reason: string }[];
    registrations: { file: string; line: number; text: string }[];
  };
  gaps: string[];
}

const OUTSIDE = "(outside)";
const BRIEF = { treeDepth: 2, groupSymbols: 12, header: 160, headers: 80, registrations: 40 };

const dirOf = (file: string) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "");

function commonDirectory(files: string[]): string {
  if (files.length === 0) return "";
  let common = dirOf(files[0]!).split("/");
  for (const file of files) {
    const parts = dirOf(file).split("/");
    let n = 0;
    while (n < common.length && common[n] === parts[n]) n++;
    common = common.slice(0, n);
  }
  return common.join("/");
}

const normalizeScope = (within: string) => within.replace(/^\.\//, "").replace(/\/+$/, "");

class Scope {
  readonly prefix: string;
  constructor(readonly path: string) {
    this.prefix = path ? `${path}/` : "";
  }
  contains(file: string): boolean {
    return file.startsWith(this.prefix);
  }
  /** The candidate a file belongs to: a direct subdirectory (`dir/`) or a direct file. */
  candidate(file: string): string {
    if (!this.contains(file)) return OUTSIDE;
    const rest = file.slice(this.prefix.length);
    const slash = rest.indexOf("/");
    return slash < 0 ? file : `${this.prefix}${rest.slice(0, slash + 1)}`;
  }
}

function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}

function directoryTree(files: string[], scope: Scope, full: boolean): MapEvidence["tree"] {
  const depthOf = (dir: string) => (dir === scope.path ? 0 : dir.slice(scope.prefix.length).split("/").length);
  const dirs = new Map<string, number>();
  for (const file of files) {
    for (let dir = dirOf(file); ; dir = dirOf(dir)) {
      if (full || depthOf(dir) <= BRIEF.treeDepth) dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
      if (dir === scope.path || dir === "") break;
    }
  }
  return [...dirs].map(([path, n]) => ({ path, files: n })).sort((a, b) => a.path.localeCompare(b.path));
}

interface ValueRef {
  from: string;
  to: string;
  def: SymbolDef;
}

function valueRefs(index: ReferenceIndex, scope: Scope): ValueRef[] {
  return index.references
    .filter((r) => !r.typeOnly)
    .map((r) => {
      const def = index.definitions.get(r.symbol)!;
      return { from: scope.candidate(r.file), to: scope.candidate(def.file), def };
    })
    .filter((r) => r.from !== r.to && r.to !== OUTSIDE);
}

function matrix(refs: ValueRef[]): MapEvidence["matrix"] {
  return [...countBy(refs, (r) => `${r.from}\0${r.to}`)]
    .map(([key, references]) => {
      const [from, to] = key.split("\0") as [string, string];
      return { from, to, references };
    })
    .sort((a, b) => b.references - a.references || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

function surfaces(refs: ValueRef[], full: boolean): MapEvidence["surfaces"] {
  const users = new Map<string, Map<string, { def: SymbolDef; by: Set<string> }>>();
  for (const r of refs) {
    const symbols = users.get(r.to) ?? new Map<string, { def: SymbolDef; by: Set<string> }>();
    const entry = symbols.get(r.def.symbol) ?? { def: r.def, by: new Set<string>() };
    entry.by.add(r.from);
    symbols.set(r.def.symbol, entry);
    users.set(r.to, symbols);
  }
  return [...users]
    .map(([candidate, symbols]) => ({
      candidate,
      symbols: symbols.size,
      groups: consumerGroups([...symbols.values()], full),
    }))
    .sort((a, b) => b.symbols - a.symbols || a.candidate.localeCompare(b.candidate));
}

function consumerGroups(entries: { def: SymbolDef; by: Set<string> }[], full: boolean) {
  const groups = new Map<string, { usedBy: string[]; symbols: string[] }>();
  for (const { def, by } of entries) {
    const usedBy = [...by].sort();
    const group = groups.get(usedBy.join("+")) ?? { usedBy, symbols: [] };
    group.symbols.push(`${def.name} (${def.file}:${def.line})`);
    groups.set(usedBy.join("+"), group);
  }
  return [...groups.values()]
    .sort((a, b) => b.symbols.length - a.symbols.length || a.usedBy.join().localeCompare(b.usedBy.join()))
    .map((g) => ({ usedBy: g.usedBy, symbols: capList(g.symbols.sort(), full ? Infinity : BRIEF.groupSymbols) }));
}

function capList(items: string[], max: number): string[] {
  return items.length <= max ? items : [...items.slice(0, max), `+${items.length - max} more`];
}

function implementations(index: ReferenceIndex, scope: Scope): MapEvidence["signals"]["implementations"] {
  const out: MapEvidence["signals"]["implementations"] = [];
  for (const [abstract, impls] of index.implementations) {
    if (!abstract.endsWith("#")) continue;
    const declared = index.definitions.get(abstract);
    if (!declared) continue;
    const defs = impls.map((s) => index.definitions.get(s)).filter((d): d is SymbolDef => d !== undefined);
    if (!scope.contains(declared.file) && !defs.some((d) => scope.contains(d.file))) continue;
    out.push({
      type: symbolName(abstract),
      file: declared.file,
      implementations: defs.map((d) => `${d.name} (${d.file})`),
    });
  }
  return out;
}

function parsePackage(text: string): { bin?: string | Record<string, string>; main?: string } {
  try {
    return JSON.parse(text) as { bin?: string | Record<string, string>; main?: string };
  } catch {
    return {};
  }
}

function packageEntries(ctx: EvidenceContext): { file: string; reason: string }[] {
  return ctx.roots
    .filter((r) => r.language === "ts")
    .flatMap((r) => {
      const file = r.root ? `${r.root}/package.json` : "package.json";
      const text = ctx.readSource(file);
      if (!text) return [];
      const pkg = parsePackage(text);
      const bins = typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin ?? {});
      return [
        ...bins.map((b) => ({ file, reason: `bin: ${b}` })),
        ...(pkg.main ? [{ file, reason: `main: ${pkg.main}` }] : []),
      ];
    });
}

function sourceSignals(files: string[], ctx: EvidenceContext, full: boolean) {
  const headers: { file: string; comment: string }[] = [];
  const entryPoints: { file: string; reason: string }[] = [];
  const found: { file: string; line: number; text: string }[] = [];
  for (const file of files) {
    const source = ctx.readSource(file);
    if (source === undefined) continue;
    const comment = headerComment(source, file);
    if (comment)
      headers.push({
        file,
        comment: full || comment.length <= BRIEF.header ? comment : `${comment.slice(0, BRIEF.header - 1)}…`,
      });
    const reason = entryPointReason(source, file);
    if (reason) entryPoints.push({ file, reason });
    found.push(...registrations(source, file).map((r) => ({ file, ...r })));
  }
  return {
    headers: full ? headers : headers.slice(0, BRIEF.headers),
    entryPoints,
    registrations: full ? found : found.slice(0, BRIEF.registrations),
  };
}

export function buildEvidence(index: ReferenceIndex, ctx: EvidenceContext, opts: EvidenceOptions): MapEvidence {
  const scope = new Scope(opts.within !== undefined ? normalizeScope(opts.within) : commonDirectory(index.files));
  const files = index.files.filter((f) => scope.contains(f));
  const refs = valueRefs(index, scope);
  const signals = sourceSignals(files, ctx, opts.full);
  const manifest = ctx.manifest?.source === "manifest" ? ctx.manifest.components : undefined;
  return {
    scope: scope.path,
    full: opts.full,
    tree: directoryTree(files, scope, opts.full),
    roots: ctx.roots,
    ...(manifest
      ? {
          manifest: manifest.map((c) => ({
            id: c.id,
            paths: c.paths,
            ...(c.description ? { description: c.description } : {}),
          })),
        }
      : {}),
    candidates: [...countBy(files, (f) => scope.candidate(f))]
      .map(([id, n]) => ({ id, files: n }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    matrix: matrix(refs),
    surfaces: surfaces(refs, opts.full),
    signals: {
      implementations: implementations(index, scope),
      barrels: index.barrels.filter((b) => scope.contains(b.file)),
      headers: signals.headers,
      entryPoints: [...packageEntries(ctx), ...signals.entryPoints],
      registrations: signals.registrations,
    },
    gaps: index.gaps,
  };
}
