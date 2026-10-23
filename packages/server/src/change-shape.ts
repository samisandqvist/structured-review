// The shape of a change: which components it touches, which of their
// contracts changed, which consumers of those contracts sit outside the
// change, and which directories it creates. Software-derived orientation for
// the reviewer, read before the walk; no model involvement.
import { posix } from "node:path";
import { componentFor, contractKindFor, type ComponentMap, type Criticality } from "./component-map.js";
import type { FileChange } from "./diff.js";

interface ShapeFile extends FileChange {
  /** Contract kind this file falls under in its component, when it does. */
  contract?: string;
}

interface ShapeComponent {
  id: string;
  description?: string;
  criticality: Criticality;
  files: ShapeFile[];
  /** Topmost directories the change creates in this component. */
  newDirectories: string[];
  /** Contract kinds with at least one changed file. */
  changedContracts: string[];
  /** Declared consumers of this component, when a contract changed. */
  consumers: { id: string; inChange: boolean }[];
}

interface OutsideConsumer {
  id: string;
  description?: string;
  criticality: Criticality;
  /** The changed components whose contracts it consumes, with the changed contract kinds. */
  via: { component: string; contracts: string[] }[];
}

export interface ChangeShape {
  source: ComponentMap["source"];
  warnings: string[];
  components: ShapeComponent[];
  /** Files a manifest assigns to no component. Always empty for an inferred map. */
  unassigned: ShapeFile[];
  /** Consumers of a changed contract with no changed file of their own. */
  outsideConsumers: OutsideConsumer[];
}

const RANK: Record<Criticality, number> = { high: 0, normal: 1, low: 2 };

/**
 * Builds the shape of `changes` against `map`. `existedAtBase` answers whether
 * a directory was already in the base tree; it decides which directories are new.
 */
export function buildChangeShape(
  changes: FileChange[],
  map: ComponentMap,
  existedAtBase: (dir: string) => boolean,
): ChangeShape {
  const specs = new Map(map.components.map((c) => [c.id, c]));
  const grouped = new Map<string, ShapeFile[]>();
  const unassigned: ShapeFile[] = [];
  for (const change of changes) {
    const id = componentFor(change.path, map);
    const contract = id === null ? null : contractKindFor(change.path, specs.get(id));
    const file: ShapeFile = contract ? { ...change, contract } : change;
    if (id === null) unassigned.push(file);
    else grouped.set(id, [...(grouped.get(id) ?? []), file]);
  }

  const newDirs = newDirectories(changes, existedAtBase);
  const components = [...grouped].map(([id, files]): ShapeComponent => {
    const spec = specs.get(id);
    const changedContracts = [...new Set(files.flatMap((f) => (f.contract ? [f.contract] : [])))];
    const consumers = changedContracts.length
      ? (spec?.consumers ?? []).map((c) => ({ id: c, inChange: grouped.has(c) }))
      : [];
    return {
      id,
      ...(spec?.description !== undefined && { description: spec.description }),
      criticality: spec?.criticality ?? "normal",
      files,
      newDirectories: newDirs.filter((dir) => files.some((f) => f.path.startsWith(`${dir}/`))),
      changedContracts,
      consumers,
    };
  });
  components.sort(
    (a, b) => RANK[a.criticality] - RANK[b.criticality] || b.files.length - a.files.length || a.id.localeCompare(b.id),
  );

  return {
    source: map.source,
    warnings: map.warnings,
    components,
    unassigned,
    outsideConsumers: outsideConsumers(components, specs),
  };
}

/** For each added or renamed-to path, the topmost of its directories that is missing from the base tree. */
function newDirectories(changes: FileChange[], existedAtBase: (dir: string) => boolean): string[] {
  const found = new Set<string>();
  const checked = new Map<string, boolean>();
  const exists = (dir: string) => {
    if (!checked.has(dir)) checked.set(dir, existedAtBase(dir));
    return checked.get(dir)!;
  };
  for (const change of changes) {
    if (change.status !== "added" && change.status !== "renamed") continue;
    let topmost: string | null = null;
    for (let dir = posix.dirname(change.path); dir !== "." && !exists(dir); dir = posix.dirname(dir)) topmost = dir;
    if (topmost) found.add(topmost);
  }
  return [...found].sort();
}

function outsideConsumers(
  components: ShapeComponent[],
  specs: Map<string, ComponentMap["components"][number]>,
): OutsideConsumer[] {
  const byId = new Map<string, OutsideConsumer>();
  for (const component of components) {
    for (const consumer of component.consumers.filter((c) => !c.inChange)) {
      const spec = specs.get(consumer.id);
      const entry = byId.get(consumer.id) ?? {
        id: consumer.id,
        ...(spec?.description !== undefined && { description: spec.description }),
        criticality: spec?.criticality ?? "normal",
        via: [],
      };
      entry.via.push({ component: component.id, contracts: component.changedContracts });
      byId.set(consumer.id, entry);
    }
  }
  return [...byId.values()].sort((a, b) => RANK[a.criticality] - RANK[b.criticality] || a.id.localeCompare(b.id));
}
