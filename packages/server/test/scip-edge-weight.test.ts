// Test edges from the SCIP provider carry the number of references behind them.
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScipGraphProvider, type BuiltGraph } from "../src/graph/scip.js";

const SUBJECT = "scip-typescript npm pkg 1.0 src/`claims.ts`/resolve().";
const TEST_MODULE = "scip-typescript npm pkg 1.0 src/`claims.property.test.ts`/";

const repo = mkdtempSync(join(tmpdir(), "srev-weight-"));
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
git("init", "-q", "-b", "main");
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
writeFileSync(join(repo, "claims.ts"), "export function resolve() {\n  return 1;\n}\n");
writeFileSync(join(repo, "claims.property.test.ts"), "import { resolve } from './claims.js';\nresolve();\n");
git("add", "-A");
git("commit", "-qm", "base");
writeFileSync(join(repo, "claims.ts"), "export function resolve() {\n  return 2;\n}\n");
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const graph: BuiltGraph = {
  nodes: new Map([
    [SUBJECT, { label: "resolve", file: "claims.ts", startLine: 1, endLine: 3, isTest: false }],
    [
      TEST_MODULE,
      { label: "claims.property.test.ts", file: "claims.property.test.ts", startLine: 1, endLine: 2, isTest: true },
    ],
  ]),
  callAdj: new Map([[TEST_MODULE, [SUBJECT]]]),
  callRev: new Map([[SUBJECT, [TEST_MODULE]]]),
  callWeights: new Map([[TEST_MODULE, new Map([[SUBJECT, 3]])]]),
  fileRequires: new Map(),
};

class FakeProvider extends ScipGraphProvider {
  protected override indexAndBuild(): Promise<BuiltGraph> {
    return Promise.resolve(graph);
  }
}

describe("change subgraph edge weights", () => {
  it("a test edge carries the reference count of the test module toward the subject", async () => {
    const sub = await new FakeProvider({ repoRoot: repo }).getChangeSubgraph("HEAD", "main");
    expect(sub.edges).toEqual([{ sourceStableId: SUBJECT, targetStableId: TEST_MODULE, edgeType: "test", weight: 3 }]);
  });
});
