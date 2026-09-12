import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { snapshotArtifacts, artifactDifferences } from "../../scripts/harness/artifacts.mjs";
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("packaged artifact freshness", () => {
  it("detects changed, missing and obsolete generated files by content", () => {
    expect(
      artifactDifferences({ same: "a", changed: "old", obsolete: "a" }, { same: "a", changed: "new", added: "b" }),
    ).toEqual(["added", "changed", "obsolete"]);
    expect(artifactDifferences({ same: "a" }, { same: "a" })).toEqual([]);
  });
  it("hashes files recursively and records missing paths without creating them", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-artifacts-"));
    dirs.push(root);
    mkdirSync(join(root, "out/sub"), { recursive: true });
    writeFileSync(join(root, "out/sub/a"), "old");
    const before = snapshotArtifacts(root, ["out", "missing"]);
    writeFileSync(join(root, "out/sub/a"), "new");
    expect(artifactDifferences(before, snapshotArtifacts(root, ["out"]))).toEqual(["out/sub/a"]);
  });
});
