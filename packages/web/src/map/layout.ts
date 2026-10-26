// ELK layout of one level. Leaf geometry is computed here: a title band on
// top, provided ports down the left side and required ports down the right.
// The first pass lets ELK choose port order with the fewest crossings
// (FIXED_SIDE); the second fixes ports at computed positions in that order
// (FIXED_POS) so they stay clear of the title and their labels.
import type { ElkExtendedEdge, ElkNode, ElkPort } from "elkjs/lib/elk-api.js";
import type { Level } from "./levels.js";
import { visibleChildren } from "./levels.js";
import { measureText } from "./measure.js";
import type { ResolvedMap } from "./types.js";

export const PORT_TOP = 50;
export const PORT_PITCH = 22;
export const NAME_FONT = '500 13px "IBM Plex Sans"';
export const SUB_FONT = '400 11px "IBM Plex Mono"';
export const PORT_FONT = '400 11.5px "IBM Plex Sans"';

export interface ElkLike {
  layout(graph: ElkNode): Promise<ElkNode>;
}
type Measure = (text: string, font: string) => number;

const ROOT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.spacing.nodeNodeBetweenLayers": "64",
  "elk.layered.spacing.edgeNodeBetweenLayers": "18",
  "elk.spacing.nodeNode": "26",
  "elk.spacing.edgeEdge": "7",
  "elk.spacing.edgeNode": "14",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.padding": "[top=30,left=30,bottom=30,right=30]",
};

/** The sub-title under a box name: "N parts · open" or "external". */
export function subtitle(map: ResolvedMap, id: string): string {
  const parts = visibleChildren(map, id).length;
  if (parts) return `${parts} parts · open`;
  return map.components.find((c) => c.id === id)?.external ? "external" : "";
}

function leaf(
  map: ResolvedMap,
  level: Level,
  id: string,
  order: Map<string, number> | null,
  measure: Measure,
): ElkNode {
  const component = map.components.find((c) => c.id === id)!;
  const names = new Map(map.interfaces.map((i) => [i.id, i.name]));
  const sub = subtitle(map, id);
  const ids = level.portsOf.get(id) ?? [];
  const rank = (pid: string) => order?.get(pid) ?? 0;
  const side = (role: string) =>
    ids.filter((pid) => level.ports.get(pid)!.role === role).sort((a, b) => rank(a) - rank(b));
  const west = side("provide");
  const east = side("require");
  const labelWidth = (list: string[]) =>
    Math.max(0, ...list.map((pid) => measure(names.get(level.ports.get(pid)!.iface)!, PORT_FONT)));
  const titleWidth = Math.max(measure(component.name, NAME_FONT), sub ? measure(sub, SUB_FONT) : 0) + 56;
  const width = Math.max(150, titleWidth, labelWidth(west) + labelWidth(east) + 40);
  const height = Math.max(sub ? 58 : 48, PORT_TOP + Math.max(west.length, east.length) * PORT_PITCH - 4);
  const portY = (i: number) => PORT_TOP + i * PORT_PITCH - 6;
  const ports: ElkPort[] = [
    ...west.map((pid, i) => ({
      id: pid,
      width: 16,
      height: 12,
      x: -16,
      y: portY(i),
      layoutOptions: { "elk.port.side": "WEST" },
    })),
    ...east.map((pid, i) => ({
      id: pid,
      width: 16,
      height: 12,
      x: width,
      y: portY(i),
      layoutOptions: { "elk.port.side": "EAST" },
    })),
  ];
  return { id, width, height, ports, layoutOptions: { "elk.portConstraints": order ? "FIXED_POS" : "FIXED_SIDE" } };
}

function frame(
  map: ResolvedMap,
  level: Level,
  P: string,
  content: { children: ElkNode[]; edges: ElkExtendedEdge[] },
  measure: Measure,
): ElkNode {
  const component = map.components.find((c) => c.id === P)!;
  const names = new Map(map.interfaces.map((i) => [i.id, i.name]));
  return {
    id: P,
    labels: [{ text: component.name, width: measure(component.name, NAME_FONT) + 20, height: 20 }],
    ...content,
    ports: (level.portsOf.get(P) ?? []).map((pid) => {
      const port = level.ports.get(pid)!;
      const name = names.get(port.iface)!;
      return {
        id: pid,
        width: 12,
        height: 12,
        layoutOptions: { "elk.port.side": port.role === "provide" ? "WEST" : "EAST", "elk.port.borderOffset": "-6" },
        labels: [{ text: name, width: measure(name, PORT_FONT) + 2, height: 14 }],
      };
    }),
    layoutOptions: {
      "elk.portConstraints": "FIXED_SIDE",
      "elk.padding": "[top=56,left=48,bottom=28,right=48]",
      "elk.portLabels.placement": "[OUTSIDE]",
      "elk.nodeLabels.placement": "[H_LEFT, V_TOP, INSIDE]",
      "elk.spacing.portPort": "22",
    },
  };
}

export function elkGraph(
  map: ResolvedMap,
  level: Level,
  order: Map<string, number> | null,
  measure: Measure = measureText,
): ElkNode {
  const P = level.id;
  const outer: ElkExtendedEdge[] = [];
  const inner: ElkExtendedEdge[] = [];
  for (const e of level.edges.values())
    (e.inside ? inner : outer).push({ id: e.id, sources: [e.from], targets: [e.to] });
  const leaves = (ids: string[]) => ids.map((id) => leaf(map, level, id, order, measure));
  if (P === null) return { id: "root", layoutOptions: ROOT_OPTIONS, children: leaves(level.children), edges: outer };
  return {
    id: "root",
    layoutOptions: ROOT_OPTIONS,
    children: [
      frame(map, level, P, { children: leaves(level.children), edges: inner }, measure),
      ...leaves(level.neighbors),
    ],
    edges: outer,
  };
}

/** Port order per node from a laid-out graph: index by vertical position. */
function portOrder(nodes: ElkNode[] | undefined, order = new Map<string, number>()): Map<string, number> {
  for (const n of nodes ?? []) {
    [...(n.ports ?? [])].sort((a, b) => a.y! - b.y!).forEach((p, i) => order.set(p.id, i));
    portOrder(n.children, order);
  }
  return order;
}

export async function layoutLevel(
  map: ResolvedMap,
  level: Level,
  elk: ElkLike,
  measure: Measure = measureText,
): Promise<ElkNode> {
  const first = await elk.layout(elkGraph(map, level, null, measure));
  return elk.layout(elkGraph(map, level, portOrder(first.children), measure));
}
