import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScipGraphProvider } from "../src/graph/scip.js";

// Real scip-python run over a tiny fixture — slow-ish (~seconds), so one test.
describe("scip-python integration", () => {
  it("indexes a python root and derives a call flow with repo-relative paths", { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "crw-py-"));
    try {
      const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
      git("init", "-b", "main");
      git("config", "user.email", "t@t");
      git("config", "user.name", "t");
      mkdirSync(join(dir, "svc"));
      writeFileSync(
        join(dir, "svc", "pyproject.toml"),
        '[project]\nname = "svc"\nversion = "0.0.1"\n\n[tool.pyright]\n',
      );
      writeFileSync(join(dir, "svc", "helper.py"), 'def greet(name: str) -> str:\n    return "hello " + name\n');
      writeFileSync(
        join(dir, "svc", "app.py"),
        'from helper import greet\n\n\ndef main() -> None:\n    print(greet("world"))\n\n\nif __name__ == "__main__":\n    main()\n',
      );
      git("add", ".");
      git("commit", "-m", "init");

      const provider = new ScipGraphProvider({ repoRoot: dir });
      const flows = await provider.getFlows();
      const main = flows.find((f) => f.name === "main");
      expect(main, `expected a 'main' flow, got: ${flows.map((f) => f.name).join(", ")}`).toBeDefined();
      expect(main!.steps.map((s) => s.label)).toEqual(["main", "greet"]);
      expect(main!.steps.map((s) => s.file)).toEqual(["svc/app.py", "svc/helper.py"]);
      expect(main!.entryReasons).toContain("cli");
      expect(main!.entryConfidence).toBe(0.8);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
