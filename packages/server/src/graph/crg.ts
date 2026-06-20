import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { GraphProvider, GraphNode, GraphEdge, ChangeSubgraph } from "./provider.js";
import type { ChangeStatus, EdgeType } from "../types.js";

interface CrgNode {
  id: string; name: string; filePath: string; startLine: number; endLine: number;
  isEntryPoint: boolean; isChanged: boolean;
}
interface CrgEdge { sourceId: string; targetId: string; type: string; }

export class CrgGraphProvider implements GraphProvider {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  constructor(private command: string[] = ["npx", "code-review-graph"]) {}

  private async getClient(): Promise<Client> {
    if (this.client) return this.client;
    this.transport = new StdioClientTransport({ command: this.command[0], args: this.command.slice(1) });
    this.client = new Client({ name: "crw-server", version: "1.0.0" }, { capabilities: {} });
    try {
      await this.client.connect(this.transport);
      return this.client;
    } catch (err) {
      this.client = null;
      this.transport = null;
      throw err;
    }
  }

  async getChangeSubgraph(branch: string, baseRef: string): Promise<ChangeSubgraph> {
    const client = await this.getClient();
    const nodesResult = await client.callTool({ name: "get_changed_nodes", arguments: { branch, baseRef } });
    const edgesResult = await client.callTool({ name: "get_changed_edges", arguments: { branch, baseRef } });
    const crgNodes = this.parseContent<CrgNode[]>(nodesResult);
    const crgEdges = this.parseContent<CrgEdge[]>(edgesResult);
    const nodes: GraphNode[] = this.mapNodes(crgNodes);
    const edges: GraphEdge[] = crgEdges.map(e => ({
      sourceStableId: e.sourceId, targetStableId: e.targetId, edgeType: "call" as EdgeType,
    }));
    return { nodes, edges };
  }

  async getNeighbors(stableId: string): Promise<{ callers: GraphNode[]; callees: GraphNode[] }> {
    const client = await this.getClient();
    const callersResult = await client.callTool({ name: "get_callers", arguments: { nodeId: stableId } });
    const calleesResult = await client.callTool({ name: "get_callees", arguments: { nodeId: stableId } });
    return {
      callers: this.mapNodes(this.parseContent<CrgNode[]>(callersResult)),
      callees: this.mapNodes(this.parseContent<CrgNode[]>(calleesResult)),
    };
  }

  private mapNodes(crgNodes: CrgNode[]): GraphNode[] {
    return crgNodes.map(n => ({
      stableId: n.id, label: n.name, file: n.filePath, startLine: n.startLine, endLine: n.endLine,
      isEntryPoint: n.isEntryPoint, changeStatus: (n.isChanged ? "changed" : "unchanged") as ChangeStatus,
    }));
  }

  private parseContent<T>(result: unknown): T {
    const content = (result as { content: { text: string }[] }).content;
    const text = content?.[0]?.text;
    return text ? JSON.parse(text) as T : [] as unknown as T;
  }

  async close(): Promise<void> {
    if (this.transport) { await this.transport.close(); this.transport = null; this.client = null; }
  }
}
