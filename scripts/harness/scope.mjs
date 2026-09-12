import { readdirSync } from "node:fs";
import { join } from "node:path";

export const sourceRoots = ["packages/server/src", "packages/skill/src", "packages/web/src", "scripts"];
export const sourceExclusions = new Map([["packages/web/src/test/setup.ts", "Vitest DOM setup, not production"]]);
const shellEntrypoints = new Set([
  "scripts/security/check.sh",
  "scripts/security/dependency-scan.sh",
  "scripts/security/probe.sh",
  "scripts/security/sast-scan.sh",
  "scripts/security/secret-scan.sh",
  "scripts/security/setup-tools.sh",
  "scripts/security/update-advisories.sh",
]);
function executable(path) {
  if (/\.d\.[cm]?ts$/.test(path) || sourceExclusions.has(path)) return false;
  if (/\.[cm]?[jt]sx?$/.test(path)) return true;
  if (/\.(?:css|proto|json|md)$/.test(path) || shellEntrypoints.has(path)) return false;
  throw new Error(`unsupported maintained source: ${path}; configure its executable checks explicitly`);
}
export function maintainedSources(root) {
  const visit = (relative) =>
    readdirSync(join(root, relative), { withFileTypes: true }).flatMap((entry) => {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) return visit(path);
      return executable(path) ? [path] : [];
    });
  return sourceRoots.flatMap(visit).sort();
}
