// A review's change on the map. The stored map describes the base; this module
// adds what the change draws (new surfaces, requirers of new crossings, their
// delegations), marks connectors new, removed or changed, and places the
// review's changed items in the components that own them, in walk order.
import type { Flow, Node, Unit } from "../api/client.js";
import { buildWalkOrder } from "../walk-order.js";
import type { Level } from "./levels.js";
import type { ChangeStatus, MapChange, ResolvedInterface, ResolvedMap } from "./types.js";

/** The map to draw: the base map plus what the change adds. */
export function drawnMap(map: ResolvedMap): ResolvedMap {
  const change = map.change;
  if (!change) return map;
  const added = new Map<string, string[]>();
  for (const c of change.crossings) {
    if (c.status === "new") added.set(c.interface, [...(added.get(c.interface) ?? []), c.requirer]);
  }
  const interfaces = map.interfaces.map((i) =>
    added.has(i.id) ? { ...i, requirers: [...new Set([...i.requirers, ...added.get(i.id)!])] } : i,
  );
  const surfaces = change.surfaces.map((s): ResolvedInterface => ({
    id: s.id,
    name: s.symbol,
    provider: s.provider,
    requirers: s.requirers,
    meaning: `New surface: ${s.symbol} is used across components, and no interface binds it.`,
    bind: [],
    evidence: [],
    bindings: [{ symbol: s.id, name: s.symbol, file: s.file, line: s.line, component: s.provider }],
    sites: s.sites.map((site) => ({ ...site, undeclared: false })),
    evidenceFiles: [],
    reasons: [],
  }));
  return { ...map, interfaces: [...interfaces, ...surfaces], delegations: [...map.delegations, ...change.delegations] };
}

const key = (...parts: string[]) => parts.join("\0");

function ancestry(map: ResolvedMap): (id: string) => string[] {
  const parentOf = new Map(map.components.map((c) => [c.id, c.parent]));
  return (id) => {
    const out: string[] = [];
    for (let at: string | null | undefined = id; at != null; at = parentOf.get(at)) out.push(at);
    return out;
  };
}

/** The delegation a connector draws, as a key of the change's delegations; undefined for assembly connectors. */
function delegationKey(level: Level, edge: { from: string; to: string; iface: string }): string | undefined {
  const from = level.ports.get(edge.from)!;
  const to = level.ports.get(edge.to)!;
  if (to.boundary && to.role === "require") return key(edge.iface, "required", to.node, from.node);
  if (from.boundary && from.role === "provide") return key(edge.iface, "provided", from.node, to.node);
  return undefined;
}

/** Change marks of a level's connectors, by edge id; unmarked connectors are absent.
 *  A delegation is new or removed when the head gained or lost it, and changed
 *  when its inner part holds added or removed call sites; other connectors take
 *  the status of the crossing their requirer side belongs to. */
export function edgeChanges(map: ResolvedMap, level: Level): Map<string, ChangeStatus> {
  const out = new Map<string, ChangeStatus>();
  const change = map.change;
  if (!change) return out;
  const crossings = new Map(change.crossings.map((c) => [key(c.interface, c.requirer), c]));
  const surfaces = new Set(change.surfaces.map((s) => s.id));
  const added = new Set(change.delegations.map((d) => key(d.interface, d.side, d.outer, d.inner)));
  const removed = new Set(change.removedDelegations.map((d) => key(d.interface, d.side, d.outer, d.inner)));
  const up = ancestry(map);
  const crossingOf = (iface: string, node: string) =>
    up(node)
      .map((a) => crossings.get(key(iface, a)))
      .find(Boolean);
  for (const edge of level.edges.values()) {
    const from = level.ports.get(edge.from)!;
    const delegation = delegationKey(level, edge);
    let status: ChangeStatus | undefined;
    if (surfaces.has(edge.iface) || (delegation && added.has(delegation))) status = "new";
    else if (delegation && removed.has(delegation)) status = "removed";
    else if (delegation)
      status = innerChanged(crossingOf(edge.iface, from.node), from.node, up) ? "changed" : undefined;
    else if (from.role === "require") status = crossingOf(edge.iface, from.node)?.status;
    if (status) out.set(edge.id, status);
  }
  return out;
}

function innerChanged(
  crossing: MapChange["crossings"][number] | undefined,
  inner: string,
  up: (id: string) => string[],
): boolean {
  return !!crossing && [...crossing.added, ...crossing.removed].some((s) => up(s.component).includes(inner));
}

/** Changed review items by the component they sit in ("" for none), in walk
 *  order. A test sits with the item it is attached to in the plan. */
export function placeItems(
  map: ResolvedMap,
  change: MapChange,
  nodes: Node[],
  units: Unit[],
  flows: Flow[],
): Map<string, Node[]> {
  const byId = new Map(map.components.map((c) => [c.id, c]));
  // A utility has no box on the map: its items sit with its nearest visible ancestor.
  const visible = (id: string): string => {
    const c = byId.get(id);
    return c?.utility && c.parent ? visible(c.parent) : id;
  };
  const byStable = new Map(nodes.map((n) => [n.stableId, n]));
  const parentOf = new Map(units.flatMap((u) => (u.attached ?? []).map((a) => [a.stableId, a.parentStableId])));
  const walk = new Map(buildWalkOrder(units, flows, nodes).map((w, i) => [w.nodeId, i]));
  const rank = (n: Node) => walk.get(n.id) ?? Number.MAX_SAFE_INTEGER;
  const changed = nodes
    .filter((n) => n.changeStatus === "changed")
    .sort((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file) || a.startLine - b.startLine);
  const out = new Map<string, Node[]>();
  for (const n of changed) {
    const parent = n.isTest ? byStable.get(parentOf.get(n.stableId) ?? "") : undefined;
    const owner = (parent && change.nodeComponents[parent.id]) ?? change.nodeComponents[n.id];
    const component = owner ? visible(owner) : "";
    out.set(component, [...(out.get(component) ?? []), n]);
  }
  return out;
}

/** Changed and reviewed item counts per component, each including its parts. */
export function itemCounts(
  map: ResolvedMap,
  placed: Map<string, Node[]>,
): Map<string, { changed: number; reviewed: number }> {
  const up = ancestry(map);
  const out = new Map<string, { changed: number; reviewed: number }>();
  for (const [component, items] of placed) {
    if (component === "") continue;
    const reviewed = items.filter((n) => n.reviewStatus !== "unreviewed").length;
    for (const id of up(component)) {
      const c = out.get(id) ?? { changed: 0, reviewed: 0 };
      out.set(id, { changed: c.changed + items.length, reviewed: c.reviewed + reviewed });
    }
  }
  return out;
}
