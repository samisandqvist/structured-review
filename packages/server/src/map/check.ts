// Checks a component model against the reference index: structure first,
// then bindings, call sites and the fidelity rules. The result is the
// resolved map the hub stores and the web view draws; `report.ok` says
// whether the hub may store it.
import type { ReferenceIndex } from "../graph/references.js";
import { resolveBindings } from "./bindings.js";
import { parseMapModel } from "./model.js";
import { ComponentTree } from "./ownership.js";
import { referenceIssues, resolveReferences, type ReferenceResolution } from "./resolve.js";
import {
  deriveDelegations,
  fileCounts,
  requirerIssues,
  resolveEvidence,
  unclaimedFiles,
  undeclaredIssues,
} from "./rules.js";
import type { CheckIssue, CheckReport, MapModel, ResolvedInterface, ResolvedMap } from "./types.js";

export function checkMap(
  json: unknown,
  index: ReferenceIndex,
  fileExists: (file: string) => boolean,
): { model: MapModel; map: ResolvedMap } {
  const { model, issues } = parseMapModel(json);
  if (issues.length > 0) return { model, map: unresolvedMap(model, issues, index.gaps) };
  const tree = new ComponentTree(model.components);
  const bound = resolveBindings(model, tree, index);
  const declared = new Map(model.interfaces.map((i) => [i.id, new Set(i.requirers)]));
  const refs = resolveReferences(index, tree, bound, declared);
  const evidenceIssues: CheckIssue[] = [];
  const interfaces = model.interfaces.map((i): ResolvedInterface => {
    const resolved: ResolvedInterface = {
      ...i,
      bindings: bound.bindings.get(i.id) ?? [],
      sites: sortSites(refs.sites.get(i.id) ?? []),
      evidenceFiles: [],
      reasons: model.undeclared
        .filter((u) => u.interface === i.id)
        .map((u) => ({ requirer: u.requirer, reason: u.reason })),
    };
    const evidence = resolveEvidence(resolved, tree, fileExists);
    evidenceIssues.push(...evidence.issues);
    return { ...resolved, evidenceFiles: evidence.files };
  });
  const allIssues = [
    ...bound.issues,
    ...referenceIssues(refs),
    ...requirerIssues(interfaces),
    ...undeclaredIssues(model, interfaces),
    ...evidenceIssues,
  ];
  const counts = fileCounts(index.files, tree);
  return {
    model,
    map: {
      title: model.title,
      components: model.components.map((c) => ({ ...c, fileCount: counts.get(c.id) ?? 0 })),
      interfaces,
      delegations: deriveDelegations(interfaces, tree),
      report: report(allIssues, refs, interfaces, unclaimedFiles(index.files, tree, model.components), index.gaps),
    },
  };
}

function sortSites<T extends { file: string; line: number }>(sites: T[]): T[] {
  return [...sites].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function report(
  issues: CheckIssue[],
  refs: ReferenceResolution,
  interfaces: ResolvedInterface[],
  unclaimed: CheckReport["unclaimedFiles"],
  gaps: string[],
): CheckReport {
  const sites = interfaces.flatMap((i) => i.sites);
  return {
    ok: issues.length === 0,
    coverage: {
      references: refs.references,
      covered: sites.length,
      undeclared: sites.filter((s) => s.undeclared).length,
    },
    issues,
    unclaimedFiles: unclaimed,
    unattributedReferences: refs.unattributed,
    utilities: [...refs.utilityRefs].map(([id, references]) => ({ id, references })),
    typeDependencies: refs.typeDependencies,
    gaps,
  };
}

function unresolvedMap(model: MapModel, issues: CheckIssue[], gaps: string[]): ResolvedMap {
  return {
    title: model.title,
    components: [],
    interfaces: [],
    delegations: [],
    report: {
      ok: false,
      coverage: { references: 0, covered: 0, undeclared: 0 },
      issues,
      unclaimedFiles: [],
      unattributedReferences: 0,
      utilities: [],
      typeDependencies: [],
      gaps,
    },
  };
}
