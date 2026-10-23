// The component manifest (`.review-components.json` at the repository root):
// a repository's own description of its components, their contracts and who
// consumes them. Optional; see docs/component-manifest.md for the format.
// Without it, components are inferred from project roots.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { matchGlob } from "./globs.js";
import { findMarkerRoots } from "./graph/roots.js";

export const MANIFEST_FILE = ".review-components.json";

export type Criticality = "high" | "normal" | "low";

export interface ComponentSpec {
  id: string;
  description?: string;
  paths: string[];
  criticality: Criticality;
  contracts: { kind: string; paths: string[] }[];
  consumers: string[];
}

export interface ComponentMap {
  source: "manifest" | "inferred";
  components: ComponentSpec[];
  warnings: string[];
}

const globList = z.array(z.string().min(1)).min(1);
const componentSchema = z.object({
  id: z.string().trim().min(1),
  description: z.string().optional(),
  paths: globList,
  criticality: z.enum(["high", "normal", "low"]).default("normal"),
  contracts: z.array(z.object({ kind: z.string().trim().min(1), paths: globList })).default([]),
  consumers: z.array(z.string().min(1)).default([]),
});
const manifestSchema = z.object({ components: z.array(z.unknown()) });

/**
 * Parses manifest text. An invalid component entry is skipped with a warning;
 * a manifest that is not JSON, has no `components` array, or keeps no valid
 * component yields no components, so the caller falls back to inference.
 */
export function parseManifest(text: string): { components: ComponentSpec[]; warnings: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { components: [], warnings: [`${MANIFEST_FILE} is not valid JSON: ${(e as Error).message}`] };
  }
  const top = manifestSchema.safeParse(json);
  if (!top.success) return { components: [], warnings: [`${MANIFEST_FILE} needs a "components" array`] };

  const warnings: string[] = [];
  const components: ComponentSpec[] = [];
  top.data.components.forEach((entry, index) => {
    const parsed = componentSchema.safeParse(entry);
    if (!parsed.success) {
      warnings.push(`${MANIFEST_FILE}: component ${index + 1} skipped: ${describeIssue(parsed.error.issues[0])}`);
    } else if (components.some((c) => c.id === parsed.data.id)) {
      warnings.push(`${MANIFEST_FILE}: duplicate component id "${parsed.data.id}" skipped`);
    } else {
      components.push(withoutUndefined(parsed.data));
    }
  });
  return { components: dropUnknownConsumers(components, warnings), warnings };
}

function describeIssue(issue: z.ZodError["issues"][number] | undefined): string {
  if (!issue) return "invalid entry";
  const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue.message}`;
}

function withoutUndefined(spec: z.infer<typeof componentSchema>): ComponentSpec {
  const { description, ...rest } = spec;
  return description === undefined ? rest : { ...rest, description };
}

function dropUnknownConsumers(components: ComponentSpec[], warnings: string[]): ComponentSpec[] {
  const ids = new Set(components.map((c) => c.id));
  return components.map((c) => {
    const unknown = c.consumers.filter((id) => !ids.has(id));
    for (const id of unknown) warnings.push(`${MANIFEST_FILE}: "${c.id}" lists unknown consumer "${id}"`);
    return { ...c, consumers: c.consumers.filter((id) => ids.has(id) && id !== c.id) };
  });
}

/** The repository's component map: its manifest when present and usable, else inferred project roots. */
export function loadComponentMap(repoRoot: string): ComponentMap {
  let text: string | null = null;
  try {
    text = readFileSync(join(repoRoot, MANIFEST_FILE), "utf8");
  } catch {
    // No manifest: inference below.
  }
  if (text !== null) {
    const { components, warnings } = parseManifest(text);
    if (components.length > 0) return { source: "manifest", components, warnings };
    return { source: "inferred", components: inferComponents(repoRoot), warnings: [...warnings, fallbackNotice()] };
  }
  return { source: "inferred", components: inferComponents(repoRoot), warnings: [] };
}

function fallbackNotice(): string {
  return `${MANIFEST_FILE} has no usable component; components are inferred from project roots`;
}

/**
 * One component per project root below the repository root (package.json,
 * pyproject.toml, pom.xml, solution files and the other markers indexing
 * uses). Deeper roots come first so a nested package claims its own files.
 */
export function inferComponents(repoRoot: string): ComponentSpec[] {
  const roots = [...new Set(findMarkerRoots(repoRoot).map((found) => found.root))].filter(Boolean);
  roots.sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b));
  return roots.map((root) => ({
    id: root,
    paths: [`${root}/**`],
    criticality: "normal",
    contracts: [],
    consumers: [],
  }));
}

/**
 * The component that owns `file`: the first component, in map order, with a
 * matching path glob. Files no component claims fall back to their top-level
 * directory in an inferred map, and to null (unassigned) under a manifest.
 */
export function componentFor(file: string, map: ComponentMap): string | null {
  const owner = map.components.find((c) => c.paths.some((glob) => matchGlob(file, glob)));
  if (owner) return owner.id;
  if (map.source === "manifest") return null;
  const slash = file.indexOf("/");
  return slash === -1 ? REPOSITORY_ROOT : file.slice(0, slash);
}

/** Component id for top-level files in an inferred map. */
export const REPOSITORY_ROOT = "(repository root)";

/** The contract kind a component declares for `file`, if any. */
export function contractKindFor(file: string, spec: ComponentSpec | undefined): string | null {
  const contract = spec?.contracts.find((c) => c.paths.some((glob) => matchGlob(file, glob)));
  return contract?.kind ?? null;
}
