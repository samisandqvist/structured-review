// `srev shape`: the change's components, changed contracts and consumers
// outside the change, as served by GET /:id/shape.

type Criticality = "high" | "normal" | "low";

interface ShapeFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
  contract?: string;
}

export interface ChangeShape {
  source: "manifest" | "inferred";
  warnings: string[];
  components: {
    id: string;
    description?: string;
    criticality: Criticality;
    files: ShapeFile[];
    newDirectories: string[];
    changedContracts: string[];
    consumers: { id: string; inChange: boolean }[];
  }[];
  unassigned: ShapeFile[];
  outsideConsumers: {
    id: string;
    description?: string;
    criticality: Criticality;
    via: { component: string; contracts: string[] }[];
  }[];
}

/** File counts by status, e.g. "3 files (1 added, 2 modified)". */
function fileSummary(files: ShapeFile[]): string {
  const counts = new Map<string, number>();
  for (const f of files) counts.set(f.status, (counts.get(f.status) ?? 0) + 1);
  const parts = [...counts].map(([status, n]) => `${n} ${status}`).join(", ");
  return `${files.length} file${files.length === 1 ? "" : "s"} (${parts})`;
}

function named(id: string, criticality: Criticality, description?: string): string {
  return `${id} [${criticality}]${description ? ` ${description}` : ""}`;
}

export function prettyShape(shape: ChangeShape): string {
  const lines = [`Components (${shape.source === "manifest" ? "from the component manifest" : "inferred"}):`];
  for (const c of shape.components) {
    lines.push(`  ${named(c.id, c.criticality, c.description)}: ${fileSummary(c.files)}`);
    if (c.changedContracts.length) lines.push(`    contracts changed: ${c.changedContracts.join(", ")}`);
    if (c.newDirectories.length) lines.push(`    new directories: ${c.newDirectories.join(", ")}`);
    if (c.consumers.length) {
      const consumers = c.consumers.map((x) => `${x.id} (${x.inChange ? "in the change" : "outside the change"})`);
      lines.push(`    consumers: ${consumers.join(", ")}`);
    }
  }
  if (shape.outsideConsumers.length) {
    lines.push("Consumers outside the change:");
    for (const o of shape.outsideConsumers) {
      const via = o.via.map((v) => `${v.contracts.join("/")} of ${v.component}`).join("; ");
      lines.push(`  ${named(o.id, o.criticality, o.description)}: uses ${via}`);
    }
  }
  if (shape.unassigned.length) lines.push(`Unassigned: ${shape.unassigned.map((f) => f.path).join(", ")}`);
  for (const w of shape.warnings) lines.push(`⚠ ${w}`);
  return lines.join("\n");
}
