// Parses an LLM-written component model and checks its structure: ids,
// the component tree, sibling relations between providers and requirers, the
// utility and external rules, and the undeclared-use entries. Resolution
// against the index only runs on a model without structural issues.
import { z } from "zod";
import type { CheckIssue, MapComponent, MapInterface, MapModel } from "./types.js";

const ID = /^[a-z0-9][a-z0-9._-]*$/;
const RESERVED_ID = "system";

const componentSchema = z
  .object({
    id: z.string(),
    name: z.string().min(1),
    parent: z.string().nullable(),
    meaning: z.string(),
    paths: z.array(z.string()).default([]),
    external: z.boolean().default(false),
    utility: z.boolean().default(false),
  })
  .strict();
const interfaceSchema = z
  .object({
    id: z.string(),
    name: z.string().min(1),
    provider: z.string(),
    requirers: z.array(z.string()).default([]),
    meaning: z.string(),
    bind: z.array(z.string().min(1)).default([]),
    kind: z.string().min(1).optional(),
    evidence: z.array(z.string().min(1)).default([]),
  })
  .strict();
const modelSchema = z.object({
  title: z.string(),
  components: z.array(componentSchema),
  interfaces: z.array(interfaceSchema).default([]),
  undeclared: z
    .array(
      z
        .object({ interface: z.string(), requirer: z.string(), component: z.string().optional(), reason: z.string() })
        .strict(),
    )
    .default([]),
});

const EMPTY_MODEL: MapModel = { title: "", components: [], interfaces: [], undeclared: [] };

export function parseMapModel(json: unknown): { model: MapModel; issues: CheckIssue[] } {
  const parsed = modelSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({
      rule: "model" as const,
      message: `${i.path.join(".") || "model"}: ${i.message}`,
    }));
    return { model: EMPTY_MODEL, issues };
  }
  const model = parsed.data as MapModel;
  const messages = [
    ...idIssues(model),
    ...treeIssues(model.components),
    ...componentIssues(model.components),
    ...model.interfaces.flatMap((i) => interfaceIssues(i, model.components)),
    ...undeclaredIssues(model),
  ];
  return { model, issues: messages.map((message) => ({ rule: "model", message })) };
}

function idIssues(model: MapModel): string[] {
  return [
    ...idsOf(
      "component",
      model.components.map((c) => c.id),
    ),
    ...idsOf(
      "interface",
      model.interfaces.map((i) => i.id),
    ),
  ];
}

function idsOf(kind: string, ids: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) out.push(`duplicate ${kind} id '${id}'`);
    seen.add(id);
    if (!ID.test(id)) out.push(`invalid ${kind} id '${id}'`);
    else if (kind === "component" && id === RESERVED_ID) out.push(`reserved component id '${id}'`);
  }
  return out;
}

function treeIssues(components: MapComponent[]): string[] {
  const byId = new Map(components.map((c) => [c.id, c]));
  const out: string[] = [];
  for (const c of components) {
    if (c.parent !== null && !byId.has(c.parent)) out.push(`component '${c.id}' has unknown parent '${c.parent}'`);
  }
  const reported = new Set<string>();
  for (const c of components) {
    const cycle = cycleFrom(c.id, byId);
    if (!cycle || cycle.some((id) => reported.has(id))) continue;
    cycle.forEach((id) => reported.add(id));
    const first = components.find((x) => cycle.includes(x.id))!;
    out.push(`parent cycle through '${first.id}'`);
  }
  if (components.length > 0 && !components.some((c) => c.parent === null)) out.push("the model has no root component");
  return out;
}

/** The components on a parent cycle reached from `id`, or undefined. */
function cycleFrom(id: string, byId: Map<string, MapComponent>): string[] | undefined {
  const path: string[] = [];
  for (let at: string | null | undefined = id; at != null; at = byId.get(at)?.parent) {
    const seenAt = path.indexOf(at);
    if (seenAt >= 0) return path.slice(seenAt);
    path.push(at);
  }
  return undefined;
}

function componentIssues(components: MapComponent[]): string[] {
  const hasParts = new Set(components.map((c) => c.parent).filter((p): p is string => p !== null));
  return components.flatMap((c) => {
    const out: string[] = [];
    if (c.external) {
      if (c.paths.length > 0) out.push(`external component '${c.id}' has paths`);
      if (c.utility) out.push(`external component '${c.id}' is a utility`);
      if (hasParts.has(c.id)) out.push(`external component '${c.id}' has parts`);
    } else if (c.paths.length === 0) {
      out.push(`component '${c.id}' needs paths`);
    }
    if (c.utility && hasParts.has(c.id)) out.push(`utility '${c.id}' has parts`);
    return out;
  });
}

function interfaceIssues(i: MapInterface, components: MapComponent[]): string[] {
  const byId = new Map(components.map((c) => [c.id, c]));
  const provider = byId.get(i.provider);
  if (!provider) return [`interface '${i.id}' has unknown provider '${i.provider}'`];
  const out = [...shapeIssues(i, provider), ...i.requirers.flatMap((r) => requirerIssues(i, provider, byId.get(r), r))];
  if (provider.utility) out.push(`utility '${provider.id}' cannot provide interface '${i.id}'`);
  return out;
}

function shapeIssues(i: MapInterface, provider: MapComponent): string[] {
  const out: string[] = [];
  if (i.kind === undefined) {
    if (i.bind.length === 0) out.push(`interface '${i.id}' needs bind entries`);
    if (i.evidence.length > 0) {
      out.push(`in-process interface '${i.id}' cannot have evidence; set kind for a cross-process interface`);
    }
    if (provider.external) out.push(`external '${provider.id}' can only provide cross-process interfaces ('${i.id}')`);
  } else if (i.bind.length > 0) {
    out.push(`cross-process interface '${i.id}' cannot have bind entries`);
  }
  return out;
}

function requirerIssues(
  i: MapInterface,
  provider: MapComponent,
  requirer: MapComponent | undefined,
  id: string,
): string[] {
  if (!requirer) return [`interface '${i.id}' has unknown requirer '${id}'`];
  if (requirer.id === provider.id) return [`interface '${i.id}' lists its provider '${id}' as a requirer`];
  if (requirer.utility) return [`utility '${id}' cannot require interface '${i.id}'`];
  if (requirer.parent !== provider.parent) {
    return [`requirer '${id}' of interface '${i.id}' is not a sibling of provider '${provider.id}'`];
  }
  return [];
}

function undeclaredIssues(model: MapModel): string[] {
  const interfaces = new Map(model.interfaces.map((i) => [i.id, i]));
  const components = new Map(model.components.map((c) => [c.id, c]));
  return model.undeclared.flatMap((u) => {
    const iface = interfaces.get(u.interface);
    if (!iface) return [`undeclared use names unknown interface '${u.interface}'`];
    if (!components.has(u.requirer))
      return [`undeclared use of '${u.interface}' names unknown component '${u.requirer}'`];
    if (!u.reason.trim()) return [`undeclared use of '${u.interface}' by '${u.requirer}' needs a reason`];
    return u.component === undefined ? [] : scopeIssues(u, iface, components);
  });
}

/** A scoped entry names a part strictly inside a requirer that the interface declares. */
function scopeIssues(
  u: MapModel["undeclared"][number],
  iface: MapInterface,
  components: Map<string, MapComponent>,
): string[] {
  const at = `undeclared use of '${u.interface}' by '${u.requirer}'`;
  if (!components.has(u.component!)) return [`${at} names unknown part '${u.component}'`];
  if (
    u.component === u.requirer ||
    cycleFrom(u.component!, components) ||
    !isInside(u.component!, u.requirer, components)
  )
    return [`${at} names '${u.component}', which is not a part inside '${u.requirer}'`];
  if (!iface.requirers.includes(u.requirer))
    return [`${at} is scoped to '${u.component}', but '${u.requirer}' is not a declared requirer; drop the scope`];
  return [];
}

function isInside(id: string, root: string, components: Map<string, MapComponent>): boolean {
  for (let at = components.get(id)?.parent ?? null; at !== null; at = components.get(at)?.parent ?? null)
    if (at === root) return true;
  return false;
}
