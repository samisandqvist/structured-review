// One level of the component map. Opening a component shows it as a frame:
// its visible parts inside, boundary ports for the interfaces it provides or
// requires, and the sibling components it connects to outside. Delegation
// connectors come from the hub's derived delegations. The level above the
// root components (null) shows the roots and the external systems.
import type { CallSite, ResolvedComponent, ResolvedInterface, ResolvedMap } from "./types.js";

export type PortRole = "provide" | "require";
export interface LevelPort {
  id: string;
  node: string;
  iface: string;
  role: PortRole;
  boundary: boolean;
}
export type EdgeKind = "assembly" | "delegate" | "undeclared";
export interface LevelEdge {
  id: string;
  from: string;
  to: string;
  iface: string;
  kind: EdgeKind;
  crossProcess: boolean;
  inside: boolean;
}
export interface Level {
  id: string | null;
  children: string[];
  neighbors: string[];
  ports: Map<string, LevelPort>;
  portsOf: Map<string, string[]>;
  edges: Map<string, LevelEdge>;
}

export function visibleChildren(map: ResolvedMap, id: string | null): ResolvedComponent[] {
  return map.components.filter((c) => c.parent === id && !c.utility);
}

/** The only internal root when it has parts, so the page opens inside it; otherwise the system level. */
export function defaultLevel(map: ResolvedMap): string | null {
  const roots = visibleChildren(map, null).filter((c) => !c.external);
  return roots.length === 1 && visibleChildren(map, roots[0]!.id).length > 0 ? roots[0]!.id : null;
}

/** The opened component and its ancestors, outermost first. */
export function levelTrail(map: ResolvedMap, id: string | null): string[] {
  const byId = new Map(map.components.map((c) => [c.id, c]));
  const trail: string[] = [];
  for (let at = id; at !== null && byId.has(at); at = byId.get(at)!.parent) trail.unshift(at);
  return trail;
}

/** Requirers of an interface: declared ones (false) and ones seen only on undeclared call sites (true). */
export function requirersOf(i: ResolvedInterface): Map<string, boolean> {
  const out = new Map(i.requirers.map((r) => [r, false]));
  for (const s of i.sites) if (!out.has(s.requirer)) out.set(s.requirer, true);
  return out;
}

export function undeclaredFindings(
  map: ResolvedMap,
): { iface: ResolvedInterface; requirer: string; sites: CallSite[] }[] {
  return map.interfaces.flatMap((iface) => {
    const byRequirer = new Map<string, CallSite[]>();
    for (const s of iface.sites.filter((x) => x.undeclared))
      byRequirer.set(s.requirer, [...(byRequirer.get(s.requirer) ?? []), s]);
    return [...byRequirer].map(([requirer, sites]) => ({ iface, requirer, sites }));
  });
}

class LevelBuilder {
  readonly level: Level;
  private parentOf: Map<string, string | null>;
  private inLevel: Set<string>;

  constructor(
    private map: ResolvedMap,
    id: string | null,
  ) {
    const children = visibleChildren(map, id).map((c) => c.id);
    this.level = { id, children, neighbors: [], ports: new Map(), portsOf: new Map(), edges: new Map() };
    this.parentOf = new Map(map.components.map((c) => [c.id, c.parent]));
    this.inLevel = new Set(children);
  }

  build(): Level {
    for (const i of this.map.interfaces) this.addInterface(i);
    return this.level;
  }

  private addInterface(i: ResolvedInterface): void {
    const P = this.level.id;
    if (this.inLevel.has(i.provider)) this.addAmong(i);
    else if (P !== null && i.provider === P) this.addProvidedByFrame(i, P);
    else if (P !== null && this.parentOf.get(i.provider) === this.parentOf.get(P)) this.addRequiredByFrame(i, P);
    if (P !== null) this.addDelegatedFromAbove(i, P);
  }

  private port(node: string, i: ResolvedInterface, role: PortRole, boundary = false): string {
    const id = `${node}|${i.id}|${role}`;
    if (!this.level.ports.has(id)) {
      this.level.ports.set(id, { id, node, iface: i.id, role, boundary });
      this.level.portsOf.set(node, [...(this.level.portsOf.get(node) ?? []), id]);
    }
    return id;
  }

  private edge(from: string, to: string, i: ResolvedInterface, kind: EdgeKind, inside: boolean): void {
    const id = `${from}>${to}`;
    this.level.edges.set(id, { id, from, to, iface: i.id, kind, crossProcess: i.kind !== undefined, inside });
  }

  private neighbor(id: string): void {
    if (!this.level.neighbors.includes(id)) this.level.neighbors.push(id);
  }

  /** Provider and requirers are parts of this level. */
  private addAmong(i: ResolvedInterface): void {
    const provided = this.port(i.provider, i, "provide");
    for (const [r, undeclared] of requirersOf(i)) {
      if (!this.inLevel.has(r)) continue;
      const kind = undeclared ? "undeclared" : "assembly";
      this.edge(this.port(r, i, "require"), provided, i, kind, this.level.id !== null);
    }
  }

  /** The opened component provides the interface to its siblings. */
  private addProvidedByFrame(i: ResolvedInterface, P: string): void {
    const boundary = this.port(P, i, "provide", true);
    for (const [r, undeclared] of requirersOf(i)) {
      if (r === P || this.parentOf.get(r) !== this.parentOf.get(P)) continue;
      this.neighbor(r);
      this.edge(this.port(r, i, "require"), boundary, i, undeclared ? "undeclared" : "assembly", false);
    }
  }

  /** The opened component requires a sibling's interface. */
  private addRequiredByFrame(i: ResolvedInterface, P: string): void {
    const requirers = requirersOf(i);
    if (!requirers.has(P)) return;
    this.neighbor(i.provider);
    const boundary = this.port(P, i, "require", true);
    this.edge(boundary, this.port(i.provider, i, "provide"), i, requirers.get(P) ? "undeclared" : "assembly", false);
  }

  /** Delegation from the frame's boundary ports to the parts that realize them. */
  private addDelegatedFromAbove(i: ResolvedInterface, P: string): void {
    for (const d of this.map.delegations) {
      if (d.interface !== i.id || d.outer !== P || !this.inLevel.has(d.inner)) continue;
      if (d.side === "provided") {
        this.edge(this.port(P, i, "provide", true), this.port(d.inner, i, "provide"), i, "delegate", true);
      } else {
        const undeclared = i.sites.some((s) => s.undeclared && this.within(s.component, d.inner));
        this.edge(
          this.port(d.inner, i, "require"),
          this.port(P, i, "require", true),
          i,
          undeclared ? "undeclared" : "delegate",
          true,
        );
      }
    }
  }

  private within(id: string, root: string): boolean {
    for (let at: string | null | undefined = id; at != null; at = this.parentOf.get(at)) if (at === root) return true;
    return false;
  }
}

export function buildLevel(map: ResolvedMap, id: string | null): Level {
  return new LevelBuilder(map, id).build();
}
