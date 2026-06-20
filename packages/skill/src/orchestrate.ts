// packages/skill/src/orchestrate.ts
import { spawn } from "node:child_process";

const SERVER_URL = process.env.CRW_SERVER_URL || "http://localhost:3456";

export interface Session { id: string; branch: string; baseRef: string; status: string; createdAt: number; }
export interface GraphNode { stableId: string; label: string; file: string; startLine: number; endLine: number; isEntryPoint: boolean; changeStatus: string; }
export interface GraphEdge { sourceStableId: string; targetStableId: string; edgeType: string; }
export interface ChangeSubgraph { nodes: GraphNode[]; edges: GraphEdge[]; }
export interface UnitInput { label: string; rationale: string; entryPointNodeIds: string[]; }

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init, headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function createSession(branch: string, baseRef: string): Promise<{ session: Session; subgraph: ChangeSubgraph }> {
  return fetchJson(`${SERVER_URL}/api/sessions`, { method: "POST", body: JSON.stringify({ branch, baseRef }) });
}

export async function writePlan(sessionId: string, units: UnitInput[]): Promise<void> {
  await fetchJson(`${SERVER_URL}/api/sessions/${sessionId}/plan`, { method: "PUT", body: JSON.stringify({ units }) });
}

export async function exportComments(sessionId: string): Promise<Record<string, unknown>> {
  return fetchJson(`${SERVER_URL}/api/sessions/${sessionId}/export`);
}

export function launchUI(sessionId: string): void {
  const url = `${SERVER_URL}?session=${sessionId}`;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

export async function orchestrate(
  branch: string, baseRef: string,
  partitionFn: (subgraph: ChangeSubgraph) => UnitInput[],
): Promise<Record<string, unknown>> {
  const { session, subgraph } = await createSession(branch, baseRef);
  const units = partitionFn(subgraph);
  await writePlan(session.id, units);
  launchUI(session.id);
  return exportComments(session.id);
}

async function main() {
  const args = process.argv.slice(2);
  const branchIdx = args.indexOf("--branch");
  const baseIdx = args.indexOf("--base");
  const branch = branchIdx >= 0 ? args[branchIdx + 1] : "HEAD";
  const baseRef = baseIdx >= 0 ? args[baseIdx + 1] : "main";

  const { session, subgraph } = await createSession(branch, baseRef);
  console.log("Session created:", session.id);
  console.log("Subgraph nodes:", subgraph.nodes.length);
  console.log("Entry points:", subgraph.nodes.filter(n => n.isEntryPoint).map(n => n.label));

  const units: UnitInput[] = subgraph.nodes
    .filter(n => n.isEntryPoint)
    .map(n => ({ label: n.label, rationale: `Entry point: ${n.label}`, entryPointNodeIds: [n.stableId] }));

  await writePlan(session.id, units);
  console.log("Plan written with", units.length, "units");
  launchUI(session.id);
  console.log("UI launched. To export comments later:");
  console.log(`  curl ${SERVER_URL}/api/sessions/${session.id}/export`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
