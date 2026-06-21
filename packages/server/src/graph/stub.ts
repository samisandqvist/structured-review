import type { GraphProvider, GraphNode, GraphEdge, ChangeSubgraph } from "./provider.js";

const STUB_NODES: GraphNode[] = [
  { stableId: "fn:handleOrder", label: "handleOrder", file: "src/orders.ts", startLine: 10, endLine: 30, isEntryPoint: true, changeStatus: "changed", isTest: false },
  { stableId: "fn:validateOrder", label: "validateOrder", file: "src/orders.ts", startLine: 35, endLine: 50, isEntryPoint: false, changeStatus: "changed", isTest: false },
  { stableId: "fn:saveOrder", label: "saveOrder", file: "src/db.ts", startLine: 100, endLine: 120, isEntryPoint: false, changeStatus: "unchanged", isTest: false },
];

const STUB_EDGES: GraphEdge[] = [
  { sourceStableId: "fn:handleOrder", targetStableId: "fn:validateOrder", edgeType: "call" },
  { sourceStableId: "fn:handleOrder", targetStableId: "fn:saveOrder", edgeType: "call" },
];

export class StubGraphProvider implements GraphProvider {
  async getChangeSubgraph(_branch: string, _baseRef: string): Promise<ChangeSubgraph> {
    return { nodes: STUB_NODES, edges: STUB_EDGES };
  }
  async getNeighbors(stableId: string): Promise<{ callers: GraphNode[]; callees: GraphNode[] }> {
    const callees = STUB_EDGES.filter(e => e.sourceStableId === stableId).map(e => STUB_NODES.find(n => n.stableId === e.targetStableId)!);
    const callers = STUB_EDGES.filter(e => e.targetStableId === stableId).map(e => STUB_NODES.find(n => n.stableId === e.sourceStableId)!);
    return { callers, callees };
  }
}
