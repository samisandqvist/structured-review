// The SCIP provider's reference index over a real scip-typescript run,
// including a namespace-import call through a barrel.
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScipGraphProvider } from "../src/graph/scip.js";
import type { IndexerJob } from "../src/graph/roots.js";

const repo = mkdtempSync(join(tmpdir(), "srev-refs-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function write(rel: string, text: string) {
  mkdirSync(join(repo, rel, ".."), { recursive: true });
  writeFileSync(join(repo, rel), text);
}
write("package.json", JSON.stringify({ name: "fixture", version: "1.0.0", type: "module" }));
write(
  "tsconfig.json",
  JSON.stringify({ compilerOptions: { module: "nodenext", target: "es2022", strict: true }, include: ["src"] }),
);
write("src/store/jobs.ts", "export function getJob(id: number): number {\n  return id;\n}\n");
write("src/store/index.ts", 'export { getJob } from "./jobs.js";\n');
write(
  "src/api/handler.ts",
  'import * as store from "../store/index.js";\n\nexport function handle(): number {\n  return store.getJob(1);\n}\n',
);
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
git("init", "-q", "-b", "main");
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
git("add", "-A");
git("commit", "-qm", "base");

describe("ScipGraphProvider.getReferenceIndex", () => {
  it("resolves a namespace member call to its defining file", async () => {
    const index = await new ScipGraphProvider({ repoRoot: repo }).getReferenceIndex();
    const ref = index.references.find((r) => r.file === "src/api/handler.ts" && r.symbol.endsWith("getJob()."));
    expect(ref).toMatchObject({ line: 4, caller: "handle", typeOnly: false });
    expect(index.definitions.get(ref!.symbol)?.file).toBe("src/store/jobs.ts");
    expect(index.files).toEqual(["src/api/handler.ts", "src/store/index.ts", "src/store/jobs.ts"]);
  }, 120_000);
});

class JobsProvider extends ScipGraphProvider {
  constructor(private jobs: IndexerJob[]) {
    super({ repoRoot: repo });
  }
  protected override planJobs() {
    return { jobs: this.jobs, warnings: ["java indexing skipped"] };
  }
  protected override runIndexer(): Promise<never[]> {
    return Promise.resolve([]);
  }
}

describe("reference index gaps", () => {
  it("reports Java and C# roots as not yet mapped next to provider warnings", async () => {
    const provider = new JobsProvider([
      { language: "ts", root: "", hasSources: false },
      { language: "cs", root: "dotnet", hasSources: true },
    ]);
    const { gaps } = await provider.getReferenceIndex();
    expect(gaps).toEqual([
      "java indexing skipped",
      "cs root 'dotnet' is not yet mapped; its code is missing from the component map",
    ]);
  });
});
