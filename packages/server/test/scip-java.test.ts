import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScipGraphProvider, resolveScipJavaCommand, type ScipJavaCommand, type BuiltGraph } from "../src/graph/scip.js";
import type { IndexerJob } from "../src/graph/roots.js";

describe("resolveScipJavaCommand", () => {
  it("honors the SCIP_JAVA_CMD override verbatim", () => {
    expect(resolveScipJavaCommand({ SCIP_JAVA_CMD: "scip-java" }))
      .toEqual({ argv0: "scip-java", args: [] });
    expect(resolveScipJavaCommand({ SCIP_JAVA_CMD: "cs launch foo --" }))
      .toEqual({ argv0: "cs", args: ["launch", "foo", "--"] });
  });

  it("finds a scip-java executable on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "crw-sj-path-"));
    writeFileSync(join(dir, "scip-java"), "#!/bin/sh\n", { mode: 0o755 });
    expect(resolveScipJavaCommand({ PATH: dir })).toEqual({ argv0: "scip-java", args: [] });
  });

  it("falls back to coursier launch with pinned (or overridden) coordinates", () => {
    const dir = mkdtempSync(join(tmpdir(), "crw-sj-cs-"));
    writeFileSync(join(dir, "cs"), "#!/bin/sh\n", { mode: 0o755 });
    expect(resolveScipJavaCommand({ PATH: dir, SCIP_JAVA_VERSION: "9.9.9" })).toEqual({
      argv0: "cs",
      args: ["launch", "com.sourcegraph:scip-java_2.13:9.9.9", "-M", "com.sourcegraph.scip_java.ScipJava", "--"],
    });
  });

  it("returns null when nothing is available", () => {
    expect(resolveScipJavaCommand({ PATH: "/nonexistent" })).toBeNull();
    expect(resolveScipJavaCommand({})).toBeNull();
  });

  it("prefers scip-java over cs when both are present", () => {
    const dir = mkdtempSync(join(tmpdir(), "crw-sj-both-"));
    writeFileSync(join(dir, "scip-java"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(dir, "cs"), "#!/bin/sh\n", { mode: 0o755 });
    expect(resolveScipJavaCommand({ PATH: dir })!.argv0).toBe("scip-java");
  });
});

// Real scip-java run over a tiny Maven fixture — slow (JVM + mvn compile),
// so one test, skipped when no Java toolchain is on this machine.
describe("scip-java integration", () => {
  it.skipIf(!resolveScipJavaCommand())(
    "indexes a maven root and derives method-level flows",
    { timeout: 300_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "crw-java-"));
      try {
        const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
        git("init", "-b", "main");
        git("config", "user.email", "t@t");
        git("config", "user.name", "t");
        mkdirSync(join(dir, "svc", "src", "main", "java", "demo"), { recursive: true });
        writeFileSync(
          join(dir, "svc", "pom.xml"),
          `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>demo</groupId><artifactId>svc</artifactId><version>0.1.0</version>
  <properties><maven.compiler.source>17</maven.compiler.source><maven.compiler.target>17</maven.compiler.target></properties>
</project>
`
        );
        writeFileSync(
          join(dir, "svc", "src", "main", "java", "demo", "Svc.java"),
          "package demo;\npublic class Svc {\n  public String greet(String name) { return \"hello \" + name; }\n}\n"
        );
        writeFileSync(
          join(dir, "svc", "src", "main", "java", "demo", "App.java"),
          "package demo;\npublic class App {\n  public String run() { return new Svc().greet(\"world\"); }\n  public static void main(String[] args) { System.out.println(new App().run()); }\n}\n"
        );
        git("add", ".");
        git("commit", "-m", "init");

        const prev = process.env.SCIP_LANGS;
        process.env.SCIP_LANGS = "java";
        try {
          const provider = new ScipGraphProvider({ repoRoot: dir });
          const flows = await provider.getFlows();
          const main = flows.find((f) => f.name === "main");
          expect(main, `expected a 'main' flow, got: ${flows.map((f) => f.name).join(", ")}`).toBeDefined();
          const labels = main!.steps.map((s) => s.label);
          expect(labels).toEqual(expect.arrayContaining(["main", "run", "greet"]));
          const greet = main!.steps.find((s) => s.label === "greet")!;
          expect(greet.file).toBe("svc/src/main/java/demo/Svc.java");
        } finally {
          if (prev === undefined) delete process.env.SCIP_LANGS;
          else process.env.SCIP_LANGS = prev;
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});

describe("java degradation (planJobs)", () => {
  const JOBS: IndexerJob[] = [
    { language: "ts", root: "", hasSources: true },
    { language: "java", root: "example-service", hasSources: true },
    { language: "py", root: "mcp/svc", hasSources: true },
  ];
  class Probe extends ScipGraphProvider {
    java: ScipJavaCommand | null = null;
    protected override discoverJobs(): IndexerJob[] { return JOBS; }
    protected override resolveJavaCommand(): ScipJavaCommand | null { return this.java; }
    plan() { return this.planJobs(); }
  }

  it("drops java jobs with a visible warning when the toolchain is missing", () => {
    const p = new Probe({ repoRoot: "/tmp" });
    const { jobs, warnings } = p.plan();
    expect(jobs.map((j) => j.language)).toEqual(["ts", "py"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Java indexing skipped/);
    expect(warnings[0]).toMatch(/'example-service'/);
    expect(warnings[0]).toMatch(/cs launch com\.sourcegraph:scip-java/);
    expect(warnings[0]).toMatch(/SCIP_JAVA_CMD/);
  });

  it("keeps java jobs and emits no warning when the toolchain resolves", () => {
    const p = new Probe({ repoRoot: "/tmp" });
    p.java = { argv0: "scip-java", args: [] };
    const { jobs, warnings } = p.plan();
    expect(jobs.map((j) => j.language)).toEqual(["ts", "java", "py"]);
    expect(warnings).toEqual([]);
  });

  it("emits no warning when no java roots exist", () => {
    class NoJava extends Probe {
      protected override discoverJobs(): IndexerJob[] { return JOBS.filter((j) => j.language !== "java"); }
    }
    const p = new NoJava({ repoRoot: "/tmp" });
    expect(p.plan().warnings).toEqual([]);
  });

  it("attaches degradation warnings to the real build (indexAndBuild wiring)", async () => {
    class JavaOnly extends ScipGraphProvider {
      protected override discoverJobs(): IndexerJob[] {
        return [{ language: "java", root: "example-service", hasSources: true }];
      }
      protected override resolveJavaCommand(): ScipJavaCommand | null { return null; }
      protected override repoStateKey(): string { return "k1"; }
    }
    const p = new JavaOnly({ repoRoot: "/tmp" });
    const warnings = await p.getIndexWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Java indexing skipped/);
    // The degraded build is a real (empty) graph, not an error.
    const flows = await p.getFlows();
    expect(flows).toEqual([]);
  });
});
