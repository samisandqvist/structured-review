import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export function snapshotArtifacts(root, paths) {
  const result = {};
  const visit = (relative) => {
    const path = join(root, relative);
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path)) visit(`${relative}/${name}`);
    } else result[relative] = createHash("sha256").update(readFileSync(path)).digest("hex");
  };
  for (const path of paths) visit(path);
  return result;
}
export function artifactDifferences(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .sort();
}
