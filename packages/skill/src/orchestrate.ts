// packages/skill/src/orchestrate.ts
import { spawn } from "node:child_process";

const SERVER_URL = process.env.CRW_SERVER_URL || "http://localhost:3456";

export interface Session { id: string; branch: string; baseRef: string; status: string; createdAt: number; }
export interface GraphNode { stableId: string; label: string; file: string; startLine: number; endLine: number; isEntryPoint: boolean; changeStatus: string; }
export interface GraphEdge { sourceStableId: string; targetStableId: string; edgeType: string; }
export interface ChangeSubgraph { nodes: GraphNode[]; edges: GraphEdge[]; }

export interface FlowDTO { id: number; name: string; affected: boolean; entryStableId: string; changedStableIds: string[]; steps: unknown[]; }
export interface OrphanDTO { stableId: string; label: string; file: string; }

export type UnitInput =
  | { kind: "flow"; flowEntryStableId?: string; flowEntryStableIds?: string[]; label: string; rationale?: string }
  | { kind: "orphans"; orphanStableIds: string[]; label: string; rationale?: string };

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

export async function getFlows(sessionId: string): Promise<{ flows: FlowDTO[]; orphans: OrphanDTO[] }> {
  return fetchJson(`${SERVER_URL}/api/sessions/${sessionId}/flows`);
}

export async function getChanges(sessionId: string): Promise<{ changes: unknown[] }> {
  return fetchJson(`${SERVER_URL}/api/sessions/${sessionId}/changes`);
}

export async function getNodes(sessionId: string): Promise<{ nodes: { id: string; stableId: string }[] }> {
  return fetchJson(`${SERVER_URL}/api/sessions/${sessionId}/nodes`);
}

export async function getNodeDiff(sessionId: string, nodeId: string): Promise<Record<string, unknown>> {
  return fetchJson(`${SERVER_URL}/api/sessions/${sessionId}/nodes/${nodeId}`);
}

export async function writePlan(
  sessionId: string, units: UnitInput[]
): Promise<{ units: unknown[]; coverage: { changedTotal: number; covered: number; unassigned: number } }> {
  return fetchJson(`${SERVER_URL}/api/sessions/${sessionId}/plan`, { method: "PUT", body: JSON.stringify({ units }) });
}

export async function exportComments(sessionId: string): Promise<{ comments: Record<string, unknown>[] }> {
  return fetchJson(`${SERVER_URL}/api/sessions/${sessionId}/export`);
}

/** Deterministic plan: one flow-unit per affected flow + one catch-all orphan unit. */
export function defaultPartition(flows: FlowDTO[], orphans: OrphanDTO[]): UnitInput[] {
  const flowUnits: UnitInput[] = flows
    .filter((f) => f.affected)
    .map((f) => ({ kind: "flow", flowEntryStableId: f.entryStableId, label: f.name }));
  const orphanUnit: UnitInput[] = orphans.length
    ? [{ kind: "orphans", orphanStableIds: orphans.map((o) => o.stableId), label: "Other changes" }]
    : [];
  return [...flowUnits, ...orphanUnit];
}

export function launchUI(sessionId: string): void {
  const url = `${SERVER_URL}?session=${sessionId}`;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

  if (cmd === "plan-context") {
    const branch = opt("--branch") ?? "HEAD";
    const baseRef = opt("--base") ?? "main";
    const { session } = await createSession(branch, baseRef);
    const { flows, orphans } = await getFlows(session.id);
    const { changes } = await getChanges(session.id);
    console.log(JSON.stringify({ sessionId: session.id, flows, orphans, changes }, null, 2));
    return;
  }
  if (cmd === "diff") {
    const sessionId = opt("--session")!;
    const stableId = opt("--node")!;
    const { nodes } = await getNodes(sessionId);
    const node = nodes.find((n) => n.stableId === stableId);
    if (!node) { console.error(`no node ${stableId}`); process.exit(1); }
    console.log(JSON.stringify(await getNodeDiff(sessionId, node!.id), null, 2));
    return;
  }
  if (cmd === "submit-plan") {
    const sessionId = opt("--session")!;
    const planPath = opt("--plan")!;
    const { readFileSync } = await import("node:fs");
    const units = JSON.parse(readFileSync(planPath, "utf8")) as UnitInput[];
    const { coverage } = await writePlan(sessionId, units);
    console.log(JSON.stringify({ coverage }, null, 2));
    launchUI(sessionId);
    return;
  }

  // Guard against unrecognized subcommands — only proceed with the default path when
  // no subcommand was given (cmd is undefined) or when the first arg is a flag (starts with --).
  if (cmd !== undefined && !cmd.startsWith("--")) {
    process.stderr.write(`Unknown command: ${cmd}\n`);
    process.exit(1);
  }

  // Default (no subcommand): create a session and write the deterministic plan.
  const branch = opt("--branch") ?? "HEAD";
  const baseRef = opt("--base") ?? "main";
  const { session } = await createSession(branch, baseRef);
  const { flows, orphans } = await getFlows(session.id);
  const { coverage } = await writePlan(session.id, defaultPartition(flows, orphans));
  console.log("Session:", session.id, "coverage:", coverage);
  launchUI(session.id);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
