import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";
import type { GraphProvider, GraphNode, GraphEdge, ChangeSubgraph, Flow } from "./provider.js";
import type { ChangeStatus, EdgeType } from "../types.js";
import { fileChangedRanges, rangesOverlap, repoFingerprint, repoRoot, subtreeFingerprint, type LineRange } from "../diff.js";
import { discoverLanguageRoots, rootHasSources, type IndexerJob } from "./roots.js";
import { isTestFile } from "../util.js";
import { buildFlowTree, makeFlow, reachesChanged } from "./flow-tree.js";
import { entryEvidence, isExportedAt, loadConfiguredEntries } from "./entry-points.js";

/**
 * Graph provider backed by SCIP (Sourcegraph Code Intelligence Protocol).
 *
 * We run a per-language SCIP indexer over the repo (scip-typescript today),
 * which emits a static, type-aware index, then derive the call graph from it:
 *  - nodes  = global definitions with a body span (enclosing_range) — functions
 *             and methods. Nested locals/anonymous callbacks roll up into their
 *             enclosing named function (this is the de-noised altitude we want).
 *  - calls  = a non-definition, non-import reference to a node symbol, attributed
 *             to the innermost named node whose body contains it.
 * Change detection is git-based (see getChangeSubgraph); SCIP gives the whole
 * repo graph and we scope it to the change + N hops of call context.
 *
 * Known gaps (addressed later by the LSP booster): scip-typescript doesn't set
 * symbol `kind`, so "is a function" is heuristic; and a reference isn't tagged
 * as a call, so call edges can include non-call references.
 */
const require = createRequire(import.meta.url);
const SCIP_PROTO = fileURLToPath(new URL("./scip.proto", import.meta.url));

interface RawNode {
  label: string;
  file: string;
  startLine: number; // 1-based
  endLine: number;
  isTest: boolean;
}
export interface BuiltGraph {
  nodes: Map<string, RawNode>; // symbol -> node
  callAdj: Map<string, string[]>; // caller -> callees (deduped)
  callRev: Map<string, string[]>; // callee -> callers
}

export interface ScipOptions {
  repoRoot?: string;
  /** Hops of call context (callers/callees) around the change. Default 1. */
  contextDepth?: number;
}

export class ScipGraphProvider implements GraphProvider {
  private repoRoot: string;
  private contextDepth: number;
  private proto?: protobuf.Root;
  private cache?: { key: string; graph: Promise<BuiltGraph> };
  private jobCache = new Map<string, { key: string; docs: Promise<ScipDocument[]> }>();

  constructor(opts: ScipOptions = {}) {
    this.repoRoot = opts.repoRoot ?? process.env.SCIP_REPO_ROOT ?? repoRoot();
    this.contextDepth = opts.contextDepth ?? Number(process.env.SCIP_CONTEXT_DEPTH ?? 1);
  }

  async getChangeSubgraph(_branch: string, baseRef: string): Promise<ChangeSubgraph> {
    const g = await this.buildGraph();

    // Changed nodes = body span overlaps a git diff hunk. Cache diffs per file.
    const rangesByFile = new Map<string, LineRange[] | null>();
    const changed = new Set<string>();
    for (const [sym, n] of g.nodes) {
      if (!rangesByFile.has(n.file)) rangesByFile.set(n.file, fileChangedRanges(baseRef, n.file, this.repoRoot));
      const ranges = rangesByFile.get(n.file);
      if (ranges && ranges.length > 0 && rangesOverlap(ranges, n.startLine, n.endLine)) changed.add(sym);
    }

    // Scope: changed nodes + N hops of callers/callees as context.
    const scope = new Set(changed);
    let frontier = [...changed];
    for (let hop = 0; hop < this.contextDepth && frontier.length; hop++) {
      const next: string[] = [];
      for (const sym of frontier) {
        for (const c of [...(g.callAdj.get(sym) ?? []), ...(g.callRev.get(sym) ?? [])]) {
          if (!scope.has(c)) {
            scope.add(c);
            next.push(c);
          }
        }
      }
      frontier = next;
    }

    const nodes: GraphNode[] = [];
    for (const sym of scope) {
      const n = g.nodes.get(sym);
      if (!n) continue;
      nodes.push({
        stableId: sym,
        label: n.label,
        file: n.file,
        startLine: n.startLine,
        endLine: n.endLine,
        isEntryPoint: false,
        changeStatus: (changed.has(sym) ? "changed" : "unchanged") as ChangeStatus,
        isTest: n.isTest,
      });
    }

    // Edges among scoped nodes. A call from a test node into production is a
    // TESTED_BY edge (production tested-by test), matching the rest of the app.
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();
    for (const [src, tgts] of g.callAdj) {
      if (!scope.has(src)) continue;
      const srcNode = g.nodes.get(src);
      for (const tgt of tgts) {
        if (src === tgt || !scope.has(tgt)) continue;
        const tgtNode = g.nodes.get(tgt);
        let edge: GraphEdge;
        if (srcNode?.isTest && !tgtNode?.isTest) {
          edge = { sourceStableId: tgt, targetStableId: src, edgeType: "test" as EdgeType };
        } else if (srcNode?.isTest) {
          continue; // test -> test internals: skip
        } else {
          edge = { sourceStableId: src, targetStableId: tgt, edgeType: "call" as EdgeType };
        }
        const key = `${edge.edgeType}\t${edge.sourceStableId}\t${edge.targetStableId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push(edge);
      }
    }

    // Entry point = changed, non-test node nothing in-scope calls.
    const called = new Set(edges.filter((e) => e.edgeType === "call").map((e) => e.targetStableId));
    for (const node of nodes) {
      if (node.changeStatus === "changed" && !node.isTest && !called.has(node.stableId)) {
        node.isEntryPoint = true;
      }
    }

    return { nodes, edges };
  }

  async getNeighbors(stableId: string): Promise<{ callers: GraphNode[]; callees: GraphNode[] }> {
    const g = await this.buildGraph();
    const toNode = (sym: string): GraphNode | null => {
      const n = g.nodes.get(sym);
      return n
        ? {
            stableId: sym,
            label: n.label,
            file: n.file,
            startLine: n.startLine,
            endLine: n.endLine,
            isEntryPoint: false,
            changeStatus: "unchanged",
            isTest: n.isTest,
          }
        : null;
    };
    const callers = (g.callRev.get(stableId) ?? []).map(toNode).filter((n): n is GraphNode => !!n);
    const callees = (g.callAdj.get(stableId) ?? []).map(toNode).filter((n): n is GraphNode => !!n);
    return { callers, callees };
  }

  async getFlows(changedStableIds?: Set<string>): Promise<Flow[]> {
    const g = await this.buildGraph();
    const relevant = changedStableIds ? reachesChanged(changedStableIds, g.callAdj) : undefined;
    const resolve = (sym: string) => {
      const n = g.nodes.get(sym);
      return n ? { label: n.label, file: n.file, startLine: n.startLine, endLine: n.endLine, isTest: n.isTest } : undefined;
    };
    // Graph roots: non-test nodes that head a call tree (have callees, no
    // NON-TEST callers) — test callers are TESTED_BY, not mid-flow evidence.
    const rootSyms = new Set(
      [...g.nodes.entries()]
        .filter(
          ([sym, n]) =>
            !n.isTest &&
            (g.callAdj.get(sym)?.length ?? 0) > 0 &&
            (g.callRev.get(sym) ?? []).filter((c) => !g.nodes.get(c)?.isTest).length === 0
        )
        .map(([sym]) => sym)
    );
    // Configured entries head flows even with callers (DI/route registration
    // hides real entry points from the call graph), but still need callees.
    const configured = loadConfiguredEntries(this.repoRoot);
    const configuredSyms = new Set(
      [...g.nodes.entries()]
        .filter(([, n]) =>
          configured.some((c) => c.label === n.label && (!c.file || n.file === c.file || n.file.endsWith("/" + c.file)))
        )
        .filter(([sym]) => (g.callAdj.get(sym)?.length ?? 0) > 0)
        .map(([sym]) => sym)
    );
    const entrySyms = [...new Set([...rootSyms, ...configuredSyms])];
    const fileCache = new Map<string, string[]>();
    return entrySyms
      .map((sym, i) => {
        const n = g.nodes.get(sym)!;
        const evidence = entryEvidence({
          isRoot: rootSyms.has(sym),
          isExported: isExportedAt(this.repoRoot, n.file, n.startLine, fileCache),
          isConfigured: configuredSyms.has(sym),
        });
        return makeFlow(i + 1, n.label, buildFlowTree(sym, g.callAdj, resolve, relevant), evidence);
      })
      .filter((f) => f.steps.length > 1)
      .sort((a, b) => b.criticality - a.criticality);
  }

  /**
   * Content-sensitive repo-state fingerprint. Any git failure yields a unique
   * key so the cache misses (never a stale hit). Content-sensitive so that
   * re-editing an already-dirty file — which leaves `git status --porcelain`
   * unchanged — still invalidates the cached index.
   */
  protected repoStateKey(): string {
    return repoFingerprint(this.repoRoot) ?? `no-git:${Math.random()}`;
  }

  /** Index at most once per repo state; concurrent callers share the in-flight build. */
  private buildGraph(): Promise<BuiltGraph> {
    if (process.env.SCIP_NO_CACHE === "1") return this.indexAndBuild();
    const key = this.repoStateKey();
    if (this.cache?.key === key) return this.cache.graph;
    const entry = { key, graph: this.indexAndBuild() };
    this.cache = entry;
    // Drop a failed build so the next call retries; callers still see the rejection.
    entry.graph.catch(() => {
      if (this.cache === entry) this.cache = undefined;
    });
    return entry.graph;
  }

  /** Enabled indexer jobs: discovered roots filtered by SCIP_LANGS (default ts,py). */
  protected discoverJobs(): IndexerJob[] {
    const enabled = new Set(
      (process.env.SCIP_LANGS ?? "ts,py").split(",").map((s) => s.trim()).filter(Boolean)
    );
    const discovered = discoverLanguageRoots(this.repoRoot);
    const jobs = discovered.filter((j) => enabled.has(j.language));
    // No marker files anywhere in the repo: preserve the old single-indexer
    // behavior (scip-typescript --infer-tsconfig at repo root).
    if (discovered.length === 0 && enabled.has("ts")) {
      return [{ language: "ts", root: "", hasSources: rootHasSources(this.repoRoot, "ts") }];
    }
    return jobs;
  }

  /** Run every enabled indexer job (each cached per subtree) and merge the documents. */
  protected async indexAndBuild(): Promise<BuiltGraph> {
    this.proto ??= await protobuf.load(SCIP_PROTO);
    const jobs = this.discoverJobs();
    const perJob = await Promise.all(jobs.map((j) => this.jobDocuments(j)));
    return buildGraphFromIndex({ documents: perJob.flat() }, this.repoRoot);
  }

  /** Subtree-scoped cache key; any git failure yields a unique key (cache miss, never stale). */
  protected jobStateKey(job: IndexerJob): string {
    return subtreeFingerprint(job.root, this.repoRoot) ?? `no-git:${Math.random()}`;
  }

  /** Index a root at most once per subtree state; concurrent callers share the run. */
  private jobDocuments(job: IndexerJob): Promise<ScipDocument[]> {
    if (process.env.SCIP_NO_CACHE === "1") return this.runIndexer(job);
    const id = `${job.language} ${job.root}`;
    const key = this.jobStateKey(job);
    const hit = this.jobCache.get(id);
    if (hit?.key === key) return hit.docs;
    const entry = { key, docs: this.runIndexer(job) };
    this.jobCache.set(id, entry);
    entry.docs.catch(() => {
      if (this.jobCache.get(id) === entry) this.jobCache.delete(id);
    });
    return entry.docs;
  }

  /** Run one job's SCIP indexer, decode its index, and re-root the documents. */
  protected async runIndexer(job: IndexerJob): Promise<ScipDocument[]> {
    const absRoot = job.root ? join(this.repoRoot, job.root) : this.repoRoot;
    const dir = mkdtempSync(join(tmpdir(), "scip-crw-"));
    const indexPath = join(dir, "index.scip");
    // --infer-tsconfig writes a tsconfig.json into the root if none exists;
    // clean it up so we don't leave an artifact in the reviewed tree.
    const tsconfigPath = join(absRoot, "tsconfig.json");
    const hadTsconfig = existsSync(tsconfigPath);
    const started = Date.now();
    try {
      try {
        if (job.language === "ts") {
          const binJs = resolveIndexerBin("@sourcegraph/scip-typescript", "scip-typescript");
          execFileSync(process.execPath, [binJs, "index", "--infer-tsconfig", "--output", indexPath], {
            cwd: absRoot,
            encoding: "utf8",
            maxBuffer: 256 * 1024 * 1024,
          });
        } else {
          throw new IndexError(`no indexer available for language '${job.language}' (root '${job.root || "."}')`);
        }
      } catch (e) {
        if (e instanceof IndexError) throw e;
        const err = e as Error & { stderr?: unknown };
        const stderr = err.stderr ? `\n${String(err.stderr).slice(-2000)}` : "";
        throw new IndexError(`${job.language} indexer failed for root '${job.root || "."}': ${err.message}${stderr}`);
      }
      this.proto ??= await protobuf.load(SCIP_PROTO);
      const Index = this.proto.lookupType("scip.Index");
      const idx = Index.toObject(Index.decode(readFileSync(indexPath)), { longs: Number, defaults: false }) as ScipIndex;
      const docs = rerootDocuments(idx.documents ?? [], job.root, absRoot);
      if (docs.length === 0 && job.hasSources) {
        throw new IndexError(
          `${job.language} indexer produced an empty index for root '${job.root || "."}', which contains ${job.language} sources`
        );
      }
      console.log(`scip: ${job.language} root '${job.root || "."}' — ${docs.length} documents in ${Date.now() - started}ms`);
      return docs;
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (job.language === "ts" && !hadTsconfig) rmSync(tsconfigPath, { force: true });
    }
  }
}

function resolveIndexerBin(pkgName: string, binName: string): string {
  const pkgPath = require.resolve(`${pkgName}/package.json`);
  const pkg = require(`${pkgName}/package.json`) as { bin: string | Record<string, string> };
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin[binName];
  return join(dirname(pkgPath), rel);
}

// ---- SCIP decoding -------------------------------------------------------

export interface ScipOccurrence {
  range?: number[];
  enclosingRange?: number[];
  symbol?: string;
  symbolRoles?: number;
}
export interface ScipDocument {
  relativePath?: string;
  occurrences?: ScipOccurrence[];
}
export interface ScipIndex {
  documents: ScipDocument[];
}

/**
 * Indexer failure surfaced to session creation as a phase error, mirroring
 * GitError: an indexer that exits non-zero or produces an empty index for a
 * root that plainly has sources must not silently yield an orphan-only plan.
 */
export class IndexError extends Error {
  readonly phase = "index" as const;
  constructor(message: string) {
    super(message);
    this.name = "IndexError";
  }
}

/**
 * Re-root one indexer job's documents to repo-relative paths. Each indexer
 * runs with cwd = its own root and emits paths relative to it (occasionally
 * absolute); the merged graph needs repo-relative paths for git diffs.
 */
export function rerootDocuments(docs: ScipDocument[], jobRoot: string, absRoot: string): ScipDocument[] {
  const absSlash = absRoot.endsWith("/") ? absRoot : `${absRoot}/`;
  const prefix = jobRoot ? `${jobRoot}/` : "";
  return docs.map((d) => {
    let p = d.relativePath ?? "";
    if (p.startsWith(absSlash)) p = p.slice(absSlash.length);
    return { ...d, relativePath: `${prefix}${p}` };
  });
}

const ROLE_DEFINITION = 0x1;
const ROLE_IMPORT = 0x2;

function labelOf(symbol: string): string | null {
  const s = symbol.replace(/\(\)\.$/, "").replace(/[.#/]+$/, "");
  const m = s.match(/([A-Za-z0-9_$]+)`?$/);
  return m ? m[1] : null;
}
// SCIP range [l,c,ec] (single line) or [sl,sc,el,ec]; 0-based. -> 1-based [start,end]
function span1(arr?: number[]): [number, number] | null {
  if (!arr || !arr.length) return null;
  return arr.length === 4 ? [arr[0] + 1, arr[2] + 1] : [arr[0] + 1, arr[0] + 1];
}

export function buildGraphFromIndex(idx: ScipIndex, root: string): BuiltGraph {
  const rootSlash = root.endsWith("/") ? root : `${root}/`;
  const rel = (p: string) => (p.startsWith(rootSlash) ? p.slice(rootSlash.length) : p);

  const nodes = new Map<string, RawNode>();
  for (const d of idx.documents) {
    const file = rel(d.relativePath ?? "");
    for (const o of d.occurrences ?? []) {
      if (!((o.symbolRoles ?? 0) & ROLE_DEFINITION)) continue;
      if (!o.symbol || o.symbol.startsWith("local ")) continue;
      if (/[#/]$/.test(o.symbol)) continue; // skip types / namespaces
      const span = span1(o.enclosingRange);
      if (!span) continue; // require a body span -> function/method
      const label = labelOf(o.symbol);
      if (!label) continue;
      nodes.set(o.symbol, { label, file, startLine: span[0], endLine: span[1], isTest: isTestFile(file) });
    }
  }

  const callSets = new Map<string, Set<string>>();
  for (const d of idx.documents) {
    const file = rel(d.relativePath ?? "");
    // node bodies defined in this document, innermost first (so refs attribute
    // to the tightest enclosing function).
    const localDefs: { symbol: string; sl: number; el: number }[] = [];
    for (const o of d.occurrences ?? []) {
      if ((o.symbolRoles ?? 0) & ROLE_DEFINITION && o.symbol && nodes.has(o.symbol)) {
        const n = nodes.get(o.symbol)!;
        if (n.file === file) localDefs.push({ symbol: o.symbol, sl: n.startLine, el: n.endLine });
      }
    }
    localDefs.sort((a, b) => a.el - a.sl - (b.el - b.sl));
    for (const o of d.occurrences ?? []) {
      const roles = o.symbolRoles ?? 0;
      if (roles & ROLE_DEFINITION || roles & ROLE_IMPORT) continue;
      if (!o.symbol || !nodes.has(o.symbol)) continue;
      const line = o.range ? o.range[0] + 1 : null;
      if (line == null) continue;
      const caller = localDefs.find((c) => line >= c.sl && line <= c.el && c.symbol !== o.symbol);
      if (!caller) continue;
      (callSets.get(caller.symbol) ?? callSets.set(caller.symbol, new Set()).get(caller.symbol)!).add(o.symbol);
    }
  }

  const callAdj = new Map<string, string[]>();
  const callRev = new Map<string, string[]>();
  for (const [src, tgts] of callSets) {
    callAdj.set(src, [...tgts]);
    for (const t of tgts) (callRev.get(t) ?? callRev.set(t, []).get(t)!).push(src);
  }
  return { nodes, callAdj, callRev };
}
