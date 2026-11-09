// Interface-level fidelity rules (declared requirers need call sites,
// undeclared uses need a reason, cross-process interfaces need evidence in
// the components they connect) and the facts derived from a resolution:
// delegation, unclaimed files and file counts.
import type { ComponentTree } from "./ownership.js";
import type { UndeclaredRule } from "./resolve.js";
import type { CallSite, CheckIssue, Delegation, MapModel, ResolvedInterface, UndeclaredReason } from "./types.js";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A call site is undeclared when its requirer is not declared, or when a scoped entry covers the part it comes from. */
export function undeclaredRule(model: MapModel, tree: ComponentTree): UndeclaredRule {
  const declared = new Map(model.interfaces.map((i) => [i.id, new Set(i.requirers)]));
  const scoped = model.undeclared.filter((u) => u.component !== undefined);
  return (iface, requirer, component) =>
    !declared.get(iface)!.has(requirer) ||
    scoped.some((u) => u.interface === iface && u.requirer === requirer && tree.within(component, u.component!));
}

/** The entry that accounts for an undeclared call site: a scoped entry covering its part, else the requirer's entry. */
function reasonFor(
  reasons: UndeclaredReason[],
  site: Pick<CallSite, "requirer" | "component">,
  tree: Pick<ComponentTree, "within">,
): UndeclaredReason | undefined {
  const own = reasons.filter((r) => r.requirer === site.requirer);
  return (
    own.find((r) => r.component !== undefined && tree.within(site.component, r.component)) ??
    own.find((r) => r.component === undefined)
  );
}

export function requirerIssues(interfaces: ResolvedInterface[]): CheckIssue[] {
  return interfaces
    .filter((i) => i.kind === undefined)
    .flatMap((i) =>
      i.requirers.flatMap((r) => {
        const sites = i.sites.filter((s) => s.requirer === r);
        if (sites.some((s) => !s.undeclared)) return [];
        const message =
          sites.length === 0
            ? `declared requirer '${r}' of interface '${i.id}' has no call sites`
            : `declared requirer '${r}' of interface '${i.id}' has only undeclared call sites; remove it from requirers and drop the scope of its undeclared entries`;
        return [{ rule: "requirer" as const, message }];
      }),
    );
}

export function undeclaredIssues(
  model: MapModel,
  interfaces: ResolvedInterface[],
  tree: Pick<ComponentTree, "within">,
): CheckIssue[] {
  const issues: CheckIssue[] = [];
  for (const i of interfaces) {
    const byRequirer = new Map<string, string[]>();
    for (const s of i.sites.filter((x) => x.undeclared && !reasonFor(i.reasons, x, tree))) {
      const where = byRequirer.get(s.requirer) ?? [];
      where.push(`${s.file}:${s.line} (${s.caller})`);
      byRequirer.set(s.requirer, where);
    }
    for (const [requirer, where] of byRequirer) {
      issues.push({
        rule: "undeclared",
        message:
          `interface '${i.id}' of '${i.provider}' is used by undeclared requirer '${requirer}' (${plural(where.length, "call site")}); ` +
          `declare the requirer or add an undeclared entry with a reason`,
        where: where.slice(0, 5),
      });
    }
  }
  for (const u of model.undeclared) {
    const i = interfaces.find((x) => x.id === u.interface)!;
    if (i.sites.some((s) => s.undeclared && reasonFor(i.reasons, s, tree) === entryReason(i, u))) continue;
    const scope = u.component === undefined ? "" : ` in '${u.component}'`;
    issues.push({
      rule: "undeclared",
      message: `undeclared entry for '${u.interface}' by '${u.requirer}'${scope} has no undeclared call sites`,
    });
  }
  return issues;
}

function entryReason(i: ResolvedInterface, u: MapModel["undeclared"][number]): UndeclaredReason | undefined {
  return i.reasons.find((r) => r.requirer === u.requirer && r.component === u.component);
}

/** Evidence files of a cross-process interface with their owners, and the issues found. */
export function resolveEvidence(
  i: ResolvedInterface,
  tree: ComponentTree,
  fileExists: (file: string) => boolean,
): { files: { file: string; component: string }[]; issues: CheckIssue[] } {
  if (i.kind === undefined) return { files: [], issues: [] };
  if (i.evidence.length === 0) {
    return {
      files: [],
      issues: [{ rule: "evidence", message: `cross-process interface '${i.id}' needs evidence files` }],
    };
  }
  const connected = [i.provider, ...i.requirers];
  const files: { file: string; component: string }[] = [];
  const issues: CheckIssue[] = [];
  for (const file of i.evidence) {
    const owner = tree.ownerOf(file);
    if (file.startsWith("/") || file.split("/").includes("..")) {
      issues.push({
        rule: "evidence",
        message: `evidence file '${file}' of interface '${i.id}' must be a repository-relative path`,
      });
    } else if (!fileExists(file)) {
      issues.push({ rule: "evidence", message: `evidence file '${file}' of interface '${i.id}' does not exist` });
    } else if (!owner || !connected.some((c) => tree.within(owner, c))) {
      issues.push({
        rule: "evidence",
        message: `evidence file '${file}' of interface '${i.id}' is outside the components it connects`,
      });
    } else {
      files.push({ file, component: owner });
    }
  }
  return { files, issues };
}

type DelegationSource = Pick<
  ResolvedInterface,
  "id" | "provider" | "requirers" | "bindings" | "sites" | "evidenceFiles"
>;

export function deriveDelegations(interfaces: DelegationSource[], tree: ComponentTree): Delegation[] {
  const seen = new Set<string>();
  const out: Delegation[] = [];
  const add = (iface: string, side: Delegation["side"], from: string, to: string) => {
    for (const step of tree.steps(from, to)) {
      const key = `${iface}\0${side}\0${step.outer}\0${step.inner}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ interface: iface, side, ...step });
    }
  };
  for (const i of interfaces) {
    for (const b of i.bindings) add(i.id, "provided", b.component, i.provider);
    for (const s of i.sites) add(i.id, "required", s.component, s.requirer);
    for (const e of i.evidenceFiles) {
      const end = [i.provider, ...i.requirers].find((c) => tree.within(e.component, c))!;
      add(i.id, end === i.provider ? "provided" : "required", e.component, end);
    }
  }
  return out;
}

/** The top-level directories the model's paths reach; files elsewhere are outside the map. */
function mappedTopLevels(components: { paths: string[] }[]): (file: string) => boolean {
  const tops = components.flatMap((c) => c.paths).map((p) => p.split(/[*?[]/)[0]!.split("/")[0]!);
  if (tops.includes("")) return () => true;
  return (file) => tops.some((t) => file === t || file.startsWith(`${t}/`));
}

/** Files under the mapped directories that no component claims, and files that fall through to a component with parts. */
export function unclaimedFiles(
  files: string[],
  tree: ComponentTree,
  components: { paths: string[] }[],
): { component: string | null; files: string[] }[] {
  const mapped = mappedTopLevels(components);
  const groups = new Map<string | null, string[]>();
  for (const file of files) {
    const owner = tree.ownerOf(file) ?? null;
    if (owner === null && !mapped(file)) continue;
    if (owner !== null && !tree.childrenOf(owner).some((c) => !c.external)) continue;
    const group = groups.get(owner) ?? [];
    group.push(file);
    groups.set(owner, group);
  }
  return [...groups].map(([component, list]) => ({ component, files: list }));
}

/** Indexed files per component, counting its whole subtree. */
export function fileCounts(files: string[], tree: ComponentTree): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const owner = tree.ownerOf(file);
    for (const id of owner ? tree.ancestors(owner) : []) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
