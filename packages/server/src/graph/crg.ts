import { execSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { GraphProvider, GraphNode, GraphEdge, ChangeSubgraph } from "./provider.js";
import type { ChangeStatus, EdgeType } from "../types.js";
import { isTestFile } from "../util.js";

/**
 * Graph provider backed by code-review-graph (CRG), an MCP server that builds a
 * tree-sitter call/dependency graph and maps git diffs onto it.
 *
 * CRG is a Python tool (`pip/uv install code-review-graph`) exposing MCP tools
 * over stdio. Point `CRG_COMMAND` at it, e.g.
 *   CRG_COMMAND=".venv-crg/bin/code-review-graph serve"
 *
 * We use three of its tools:
 *  - build_or_update_graph_tool — (re)build the graph for the current checkout
 *  - get_impact_radius_tool      — the change subgraph: changed nodes, ±N-hop
 *                                  context, and the edges among them, all keyed
 *                                  by stable qualified names
 *  - query_graph_tool            — callers_of / callees_of for local moves
 */

// CRG node kinds that are reviewable units of code. "File" nodes are too coarse
// and "Class" nodes float disconnected (their CONTAINS links to methods aren't
// call edges) — the methods carry the actual calls, so we keep those instead.
const UNIT_KINDS = new Set(["Function", "Method", "Test"]);

// CRG sometimes extracts a "function" for an inline lambda parameter (`.catch(e
// => …)`, `(n) => …`). These surface as 1–2 char nodes that are pure noise in a
// review graph. Real functions are ~never that short.
const isNoiseName = (name: string) => name.trim().length <= 2;

// CRG only flags actual test cases (it/describe) as tests, so helpers defined in
// a test file leak into the non-test view. Treat anything in a test file as test.
const isTestNode = (n: CrgNode) => n.kind === "Test" || n.is_test === true || isTestFile(n.file_path);

interface CrgNode {
  id: number;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  line_start: number;
  line_end: number;
  language?: string;
  parent_name?: string | null;
  is_test?: boolean;
}
interface CrgEdge {
  kind: string; // CALLS | CONTAINS | IMPORTS_FROM | TESTED_BY | REFERENCES
  source: string; // qualified_name
  target: string; // qualified_name
}
interface ImpactResult {
  status: string;
  changed_nodes: CrgNode[];
  impacted_nodes: CrgNode[];
  edges: CrgEdge[];
}
interface QueryResult {
  status: string;
  results?: CrgNode[];
}

export interface CrgOptions {
  /** Repo root for relativizing paths and scoping CRG. Defaults to git root. */
  repoRoot?: string;
  /** Hops of unchanged context to pull around the change. Default 2. */
  impactDepth?: number;
  /** Incrementally rebuild the graph before querying. Default true. */
  build?: boolean;
}

export class CrgGraphProvider implements GraphProvider {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private repoRoot: string;
  private impactDepth: number;
  private build: boolean;

  constructor(
    private command: string[] = ["code-review-graph", "serve"],
    opts: CrgOptions = {},
  ) {
    this.repoRoot = opts.repoRoot ?? process.env.CRG_REPO_ROOT ?? detectRepoRoot();
    this.impactDepth = opts.impactDepth ?? Number(process.env.CRG_IMPACT_DEPTH ?? 2);
    this.build = opts.build ?? process.env.CRG_SKIP_BUILD === undefined;
  }

  private async getClient(): Promise<Client> {
    if (this.client) return this.client;
    const [command, ...args] = this.command;
    if (!command) throw new Error("CRG command must contain an executable");
    this.transport = new StdioClientTransport({
      command,
      args,
    });
    this.client = new Client({ name: "srev-server", version: "1.0.0" }, { capabilities: {} });
    try {
      await this.client.connect(this.transport);
      return this.client;
    } catch (err) {
      this.client = null;
      this.transport = null;
      throw err;
    }
  }

  /**
   * `branch` is informational: CRG diffs the current checkout against `baseRef`,
   * so the working tree must already be on the branch under review.
   */
  async getChangeSubgraph(_branch: string, baseRef: string): Promise<ChangeSubgraph> {
    if (this.build) {
      await this.callTool("build_or_update_graph_tool", {
        full_rebuild: false,
        base: baseRef,
        repo_root: this.repoRoot,
      });
    }
    const impact = await this.callTool<ImpactResult>("get_impact_radius_tool", {
      base: baseRef,
      max_depth: this.impactDepth,
      repo_root: this.repoRoot,
      detail_level: "standard",
    });

    // qualified_name -> node. Changed wins over context if a node appears twice.
    const byId = new Map<string, GraphNode>();
    const add = (n: CrgNode, changed: boolean) => {
      if (!UNIT_KINDS.has(n.kind) || isNoiseName(n.name)) return;
      const existing = byId.get(n.qualified_name);
      if (existing) {
        if (changed) existing.changeStatus = "changed";
        return;
      }
      byId.set(n.qualified_name, {
        stableId: n.qualified_name,
        label: n.name,
        file: this.rel(n.file_path),
        startLine: n.line_start,
        endLine: n.line_end,
        isEntryPoint: false,
        changeStatus: (changed ? "changed" : "unchanged") as ChangeStatus,
        isTest: isTestNode(n),
      });
    };
    for (const n of impact.changed_nodes ?? []) add(n, true);
    for (const n of impact.impacted_nodes ?? []) add(n, false);

    // Keep CALLS edges (the call graph) and TESTED_BY edges (node -> its tests)
    // between nodes we kept; drop self-loops and dedupe.
    const seen = new Set<string>();
    const edges: GraphEdge[] = [];
    for (const e of impact.edges ?? []) {
      const edgeType: EdgeType | null = e.kind === "CALLS" ? "call" : e.kind === "TESTED_BY" ? "test" : null;
      if (!edgeType) continue;
      if (e.source === e.target) continue; // CRG name-resolution can emit self-loops
      if (!byId.has(e.source) || !byId.has(e.target)) continue;
      const key = `${edgeType}\t${e.source}\t${e.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ sourceStableId: e.source, targetStableId: e.target, edgeType });
    }

    // Entry point = a changed, non-test node that nothing in the subgraph calls
    // (top of a chain). Tests are never entry points. (Final change-status
    // refinement and context pruning happen in the sessions route, which has
    // the git diff — see reconcileSubgraph there.)
    const called = new Set(edges.filter((e) => e.edgeType === "call").map((e) => e.targetStableId));
    for (const node of byId.values()) {
      if (node.changeStatus === "changed" && !node.isTest && !called.has(node.stableId)) {
        node.isEntryPoint = true;
      }
    }

    return { nodes: [...byId.values()], edges };
  }

  async getFlows(changedStableIds?: Set<string>) {
    const { readFlows } = await import("../flows.js");
    return readFlows(this.repoRoot, changedStableIds);
  }

  async getNeighbors(stableId: string): Promise<{ callers: GraphNode[]; callees: GraphNode[] }> {
    const [callers, callees] = await Promise.all([
      this.callTool<QueryResult>("query_graph_tool", {
        pattern: "callers_of",
        target: stableId,
        repo_root: this.repoRoot,
      }),
      this.callTool<QueryResult>("query_graph_tool", {
        pattern: "callees_of",
        target: stableId,
        repo_root: this.repoRoot,
      }),
    ]);
    return { callers: this.mapQueryNodes(callers), callees: this.mapQueryNodes(callees) };
  }

  /** Map query_graph results to context nodes, skipping unresolved built-ins. */
  private mapQueryNodes(res: QueryResult): GraphNode[] {
    return (res.results ?? [])
      .filter((n) => UNIT_KINDS.has(n.kind) && n.qualified_name && n.file_path && !isNoiseName(n.name))
      .map((n) => ({
        stableId: n.qualified_name,
        label: n.name,
        file: this.rel(n.file_path),
        startLine: n.line_start,
        endLine: n.line_end,
        isEntryPoint: false,
        changeStatus: "unchanged" as ChangeStatus,
        isTest: isTestNode(n),
      }));
  }

  private rel(filePath: string): string {
    const root = this.repoRoot.endsWith("/") ? this.repoRoot : `${this.repoRoot}/`;
    return filePath.startsWith(root) ? filePath.slice(root.length) : filePath;
  }

  private async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    const client = await this.getClient();
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: unknown;
      content?: { type?: string; text?: string }[];
    };
    if (res.isError) {
      throw new Error(`CRG tool ${name} failed: ${JSON.stringify(res.content)}`);
    }
    if (res.structuredContent && typeof res.structuredContent === "object") {
      return res.structuredContent as T;
    }
    const text = res.content?.find((c) => typeof c.text === "string")?.text;
    if (text) return JSON.parse(text) as T;
    throw new Error(`CRG tool ${name} returned no parseable content`);
  }

  async close(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
      this.client = null;
    }
  }
}

function detectRepoRoot(): string {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}
