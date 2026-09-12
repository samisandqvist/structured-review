import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { maintainedSources, sourceRoots } from "../../scripts/harness/scope.mjs";
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("includes unimported JS and TS modules while rejecting an unsupported executable language", () => {
  const root = mkdtempSync(join(tmpdir(), "srev-source-scope-"));
  roots.push(root);
  for (const path of sourceRoots) mkdirSync(join(root, path), { recursive: true });
  mkdirSync(join(root, "packages/web/src/test"));
  writeFileSync(join(root, "packages/web/src/test/setup.ts"), "// test setup");
  mkdirSync(join(root, "scripts/security"));
  writeFileSync(join(root, "scripts/security/check.sh"), "#!/bin/bash\ntrue\n");
  writeFileSync(join(root, "scripts/new.js"), "export const missing = 1;");
  writeFileSync(join(root, "scripts/worker.cts"), "export const worker = 1;");
  expect(maintainedSources(root)).toEqual(["scripts/new.js", "scripts/worker.cts"]);
  writeFileSync(join(root, "scripts/unverified.py"), "print('unverified')");
  expect(() => maintainedSources(root)).toThrow(/unsupported.*unverified.py/);
});
