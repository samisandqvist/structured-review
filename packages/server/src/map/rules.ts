// Interface-level fidelity rules (declared requirers need call sites,
// undeclared uses need a reason, cross-process interfaces need evidence in
// the components they connect) and the facts derived from a resolution:
// delegation, unclaimed files and file counts.
import type { ComponentTree } from "./ownership.js";
import type { CheckIssue, Delegation, MapModel, ResolvedInterface } from "./types.js";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function requirerIssues(interfaces: ResolvedInterface[]): CheckIssue[] {
  return interfaces
    .filter((i) => i.kind === undefined)
    .flatMap((i) =>
      i.requirers
        .filter((r) => !i.sites.some((s) => s.requirer === r))
        .map((r) => ({
          rule: "requirer" as const,
          message: `declared requirer '${r}' of interface '${i.id}' has no call sites`,
        })),
    );
}

export function undeclaredIssues(model: MapModel, interfaces: ResolvedInterface[]): CheckIssue[] {
  const issues: CheckIssue[] = [];
  for (const i of interfaces) {
    const byRequirer = new Map<string, string[]>();
    for (const s of i.sites.filter((x) => x.undeclared)) {
      byRequirer.set(s.requirer, [...(byRequirer.get(s.requirer) ?? []), `${s.file}:${s.line} (${s.caller})`]);
    }
    for (const [requirer, where] of byRequirer) {
      if (i.reasons.some((r) => r.requirer === requirer)) continue;
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
    if (i.sites.some((s) => s.undeclared && s.requirer === u.requirer)) continue;
    issues.push({
      rule: "undeclared",
      message: `undeclared entry for '${u.interface}' by '${u.requirer}' has no undeclared call sites`,
    });
  }
  return issues;
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
    if (!fileExists(file)) {
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

export function deriveDelegations(interfaces: ResolvedInterface[], tree: ComponentTree): Delegation[] {
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

/** Top-level directories the model's paths reach; files elsewhere are outside the map. */
function mappedTopLevels(components: { paths: string[] }[]): (file: string) => boolean {
  const tops = new Set(components.flatMap((c) => c.paths).map((p) => (p.includes("/") ? `${p.split("/")[0]}/` : "")));
  return (file) => [...tops].some((t) => file.startsWith(t));
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
    groups.set(owner, [...(groups.get(owner) ?? []), file]);
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
