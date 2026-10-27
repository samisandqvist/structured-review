// A review's change on a map built from its base: the stored model applied to
// the head index and compared with the base map. Every mark comes from the
// two indexes and the diff; the model only names the structure, so it cannot
// declare the change away.
import type { LineRange } from "../diff.js";
import type { ReferenceIndex } from "../graph/references.js";
import { resolveBindings, type ResolvedBindings } from "./bindings.js";
import { ComponentTree } from "./ownership.js";
import { resolveReferences } from "./resolve.js";
import { deriveDelegations } from "./rules.js";
import type {
  CallSite,
  CrossingChange,
  Delegation,
  MapChange,
  MapModel,
  NewSurface,
  ResolvedMap,
  TouchedContract,
} from "./types.js";

const MAX_SAMPLES = 5;

interface ChangeNode {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  isTest: boolean;
  /** A per-file residual: its span covers unrelated lines, so only its file counts. */
  residual: boolean;
  changed: boolean;
}

export interface ChangeInput {
  model: MapModel;
  base: ResolvedMap;
  head: ReferenceIndex;
  nodes: ChangeNode[];
  files: { path: string; status: string; oldPath?: string }[];
  changedLines: (file: string) => LineRange[];
}

export function compareVersions(input: ChangeInput, baseSha: string): MapChange {
  const tree = new ComponentTree(input.model.components);
  const bound = resolveBindings(input.model, tree, input.head);
  const declared = new Map(input.model.interfaces.map((i) => [i.id, new Set(i.requirers)]));
  const refs = resolveReferences(input.head, tree, bound, declared);
  const changedPaths = new Set(input.files.flatMap((f) => [f.path, ...(f.oldPath ? [f.oldPath] : [])]));
  const keep = siteGuard(input.base, bound, changedPaths);
  const headSites = input.model.interfaces.map((i) => ({ id: i.id, sites: refs.sites.get(i.id) ?? [] }));
  const surfaces = refs.uncovered
    .map((u): NewSurface => ({
      id: `new:${u.provider}:${u.def.file}:${u.def.name}`,
      provider: u.provider,
      requirers: [...u.from].sort(),
      symbol: u.def.name,
      file: u.def.file,
      line: u.def.line,
      references: u.count,
      where: u.where.slice(0, MAX_SAMPLES),
      sites: u.sites.filter((s) => changedPaths.has(s.file) || changedPaths.has(u.def.file)),
    }))
    .filter((s) => s.sites.length > 0);
  const changed = input.nodes.filter((n) => n.changed);
  const crossed = crossings(input.base.interfaces, headSites, keep);
  return {
    baseSha,
    ...placement(tree, changed, input.files),
    crossings: crossed,
    surfaces,
    ...delegationChanges(tree, input.base, bound, crossed, surfaces),
    touched: touched(input, bound, changed, changedPaths),
  };
}

/** Keeps a call site whose calling file or called definition changed. Calls
 *  between unchanged files can differ between two indexes only as an artefact
 *  of indexing (a workspace package resolved in one checkout only). */
function siteGuard(
  base: ResolvedMap,
  bound: ResolvedBindings,
  changedPaths: Set<string>,
): (iface: string, site: CallSite) => boolean {
  const targets = new Map<string, Set<string>>();
  const add = (iface: string, name: string, file: string) => {
    const key = `${iface}\0${name}`;
    targets.set(key, (targets.get(key) ?? new Set()).add(file));
  };
  for (const i of base.interfaces) for (const b of i.bindings) add(i.id, b.name, b.file);
  for (const [iface, list] of bound.bindings) for (const b of list) add(iface, b.name, b.file);
  return (iface, site) =>
    changedPaths.has(site.file) ||
    [...(targets.get(`${iface}\0${site.symbol}`) ?? [])].some((f) => changedPaths.has(f));
}

const delegationKey = (d: Delegation) => `${d.interface}\0${d.side}\0${d.outer}\0${d.inner}`;

/** Delegations the head has and the base map lacks, and the reverse. The head's
 *  sites are the base's minus the removed ones plus the added ones. */
function delegationChanges(
  tree: ComponentTree,
  base: ResolvedMap,
  bound: ResolvedBindings,
  crossed: CrossingChange[],
  surfaces: NewSurface[],
): Pick<MapChange, "delegations" | "removedDelegations"> {
  const removed = new Set(crossed.flatMap((c) => c.removed.map((s) => `${c.interface}\0${siteKey(s)}`)));
  const head = base.interfaces.map((i) => ({
    ...i,
    bindings: bound.bindings.get(i.id) ?? [],
    sites: [
      ...i.sites.filter((s) => !removed.has(`${i.id}\0${siteKey(s)}`)),
      ...crossed.filter((c) => c.interface === i.id).flatMap((c) => c.added),
    ],
  }));
  const shapes = surfaces.map((s) => ({
    id: s.id,
    provider: s.provider,
    requirers: [],
    sites: s.sites,
    evidenceFiles: [],
    bindings: [{ symbol: s.id, name: s.symbol, file: s.file, line: s.line, component: tree.ownerOf(s.file)! }],
  }));
  const after = deriveDelegations([...head, ...shapes], tree);
  const afterKeys = new Set(after.map(delegationKey));
  const beforeKeys = new Set(base.delegations.map(delegationKey));
  return {
    delegations: after.filter((d) => !beforeKeys.has(delegationKey(d))),
    removedDelegations: base.delegations.filter((d) => !afterKeys.has(delegationKey(d))),
  };
}

const crossingKey = (iface: string, requirer: string) => `${iface}\0${requirer}`;
const siteKey = (s: CallSite) => `${s.file}|${s.caller}|${s.symbol}`;

function byCrossing(interfaces: { id: string; sites: CallSite[] }[]): Map<string, CallSite[]> {
  const out = new Map<string, CallSite[]>();
  for (const i of interfaces) {
    for (const site of i.sites) {
      const key = crossingKey(i.id, site.requirer);
      out.set(key, [...(out.get(key) ?? []), site]);
    }
  }
  return out;
}

function crossings(
  base: { id: string; sites: CallSite[] }[],
  head: { id: string; sites: CallSite[] }[],
  keep: (iface: string, site: CallSite) => boolean,
): CrossingChange[] {
  const before = byCrossing(base);
  const after = byCrossing(head);
  const out: CrossingChange[] = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const [iface, requirer] = key.split("\0") as [string, string];
    const old = before.get(key) ?? [];
    const now = after.get(key) ?? [];
    const oldKeys = new Set(old.map(siteKey));
    const newKeys = new Set(now.map(siteKey));
    const added = now.filter((s) => !oldKeys.has(siteKey(s)) && keep(iface, s));
    const removed = old.filter((s) => !newKeys.has(siteKey(s)) && keep(iface, s));
    if (added.length === 0 && removed.length === 0) continue;
    const gone = removed.length === old.length && added.length === 0 && now.length === 0;
    const status = old.length === 0 ? "new" : gone ? "removed" : "changed";
    out.push({ interface: iface, requirer, status, added, removed });
  }
  return out;
}

function touched(
  input: ChangeInput,
  bound: ResolvedBindings,
  changed: ChangeNode[],
  changedPaths: Set<string>,
): TouchedContract[] {
  const spans = changed.filter((n) => !n.residual && !n.isTest);
  const overlaps = (file: string, start: number, end: number) =>
    spans.some((n) => n.file === file && n.startLine <= end && start <= n.endLine) ||
    input.changedLines(file).some((r) => r.start <= end && start <= r.end);
  const baseBindings = new Map(input.base.interfaces.map((i) => [i.id, i.bindings]));
  const out: TouchedContract[] = [];
  for (const iface of input.model.interfaces) {
    const head = bound.bindings.get(iface.id) ?? [];
    const headNames = new Set(head.map((b) => b.name));
    const endOf = (b: (typeof head)[number]) => input.head.definitions.get(b.symbol)?.endLine ?? b.line;
    const body = head.filter((b) => overlaps(b.file, b.line, endOf(b))).map((b) => b.name);
    const lost = (baseBindings.get(iface.id) ?? []).filter((b) => !headNames.has(b.name)).map((b) => b.name);
    const evidence = iface.evidence.some((f) => changedPaths.has(f));
    const reasons: TouchedContract["reasons"] = [
      ...(body.length > 0 ? (["body"] as const) : []),
      ...(lost.length > 0 ? (["binding-lost"] as const) : []),
      ...(evidence ? (["evidence"] as const) : []),
    ];
    if (reasons.length > 0) out.push({ interface: iface.id, reasons, symbols: [...body, ...lost] });
  }
  return out;
}

function placement(
  tree: ComponentTree,
  changed: ChangeNode[],
  files: ChangeInput["files"],
): Pick<MapChange, "components" | "nodeComponents" | "unmapped"> {
  const counts = new Map<string, { items: number; files: number }>();
  const bump = (owner: string | undefined, field: "items" | "files") => {
    for (const id of owner ? tree.ancestors(owner) : []) {
      const entry = counts.get(id) ?? { items: 0, files: 0 };
      entry[field]++;
      counts.set(id, entry);
    }
  };
  const nodeComponents: Record<string, string | null> = {};
  for (const node of changed) {
    const owner = tree.ownerOf(node.file);
    nodeComponents[node.id] = owner ?? null;
    if (!node.isTest) bump(owner, "items");
  }
  const unmapped = new Map<string | null, string[]>();
  for (const file of files) {
    for (const path of [file.path, ...(file.oldPath ? [file.oldPath] : [])]) bump(tree.ownerOf(path), "files");
    const owner = tree.ownerOf(file.path) ?? null;
    if (owner !== null && !tree.childrenOf(owner).some((c) => !c.external)) continue;
    unmapped.set(owner, [...(unmapped.get(owner) ?? []), file.path]);
  }
  return {
    components: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([id, c]) => ({ id, ...c })),
    nodeComponents,
    unmapped: [...unmapped].map(([component, list]) => ({ component, files: list })),
  };
}
