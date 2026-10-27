// The component tree of a model: navigation and file ownership. A file
// belongs to the deepest component with a matching path; between components
// at the same depth the longer pattern wins. A null ancestor stands for the
// system level above the root components.
import { matchGlob } from "../globs.js";
import type { MapComponent } from "./types.js";

const GLOB = /[*?[]/;

function patternMatches(pattern: string, file: string): boolean {
  if (pattern === "") return true;
  if (pattern.endsWith("/")) return file.startsWith(pattern);
  if (GLOB.test(pattern)) return matchGlob(file, pattern);
  return file === pattern || file.startsWith(`${pattern}/`);
}

export class ComponentTree {
  private byId: Map<string, MapComponent>;
  private owners = new Map<string, string | undefined>();

  constructor(private components: MapComponent[]) {
    this.byId = new Map(components.map((c) => [c.id, c]));
  }

  get(id: string): MapComponent | undefined {
    return this.byId.get(id);
  }

  parentOf(id: string): string | null {
    return this.byId.get(id)?.parent ?? null;
  }

  childrenOf(id: string | null): MapComponent[] {
    return this.components.filter((c) => c.parent === id);
  }

  /** The component and its ancestors, self first. */
  ancestors(id: string): string[] {
    const out: string[] = [];
    for (let at: string | null = id; at !== null && this.byId.has(at); at = this.parentOf(at)) out.push(at);
    return out;
  }

  within(id: string, root: string): boolean {
    return this.ancestors(id).includes(root);
  }

  lca(a: string, b: string): string | null {
    const above = new Set(this.ancestors(a));
    return this.ancestors(b).find((x) => above.has(x)) ?? null;
  }

  /** The child of `ancestor` on the way to `id`; undefined when `id` is not strictly below it. */
  childToward(ancestor: string | null, id: string): string | undefined {
    return this.ancestors(id).find((x) => x !== ancestor && this.parentOf(x) === ancestor);
  }

  /** Parent/child steps from `from` up to its ancestor `to`. */
  steps(from: string, to: string): { outer: string; inner: string }[] {
    const out: { outer: string; inner: string }[] = [];
    for (const inner of this.ancestors(from)) {
      if (inner === to) break;
      out.push({ outer: this.parentOf(inner)!, inner });
    }
    return out;
  }

  ownerOf(file: string): string | undefined {
    if (!this.owners.has(file)) this.owners.set(file, this.findOwner(file));
    return this.owners.get(file);
  }

  private findOwner(file: string): string | undefined {
    let best: { id: string; depth: number; length: number } | undefined;
    for (const c of this.components) {
      if (c.external) continue;
      const depth = this.ancestors(c.id).length;
      for (const pattern of c.paths) {
        if (!patternMatches(pattern, file)) continue;
        if (!best || depth > best.depth || (depth === best.depth && pattern.length > best.length)) {
          best = { id: c.id, depth, length: pattern.length };
        }
      }
    }
    return best?.id;
  }
}
