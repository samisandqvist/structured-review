import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  loadConfiguredEntries,
  isExportedAt,
  entryEvidence,
  pythonEntryReasons,
  csharpEntryReasons,
} from "../src/graph/entry-points.js";

describe("entryEvidence", () => {
  it("scores configured entries 1.0 regardless of other flags", () => {
    expect(entryEvidence({ isRoot: false, isExported: false, isConfigured: true })).toEqual({
      reasons: ["configured"],
      confidence: 1.0,
    });
    expect(entryEvidence({ isRoot: true, isExported: true, isConfigured: true })).toEqual({
      reasons: ["graph-root", "exported", "configured"],
      confidence: 1.0,
    });
  });
  it("scores exported graph roots 0.7", () => {
    expect(entryEvidence({ isRoot: true, isExported: true, isConfigured: false })).toEqual({
      reasons: ["graph-root", "exported"],
      confidence: 0.7,
    });
  });
  it("scores bare graph roots 0.4", () => {
    expect(entryEvidence({ isRoot: true, isExported: false, isConfigured: false })).toEqual({
      reasons: ["graph-root"],
      confidence: 0.4,
    });
  });
});

describe("loadConfiguredEntries", () => {
  it("reads .srev-entry-points.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "srev-entries-"));
    writeFileSync(
      join(dir, ".srev-entry-points.json"),
      JSON.stringify({ entryPoints: [{ label: "main", file: "src/cli.ts" }] }),
    );
    expect(loadConfiguredEntries(dir)).toEqual([{ label: "main", file: "src/cli.ts" }]);
  });
  it("returns [] when the file is missing or invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "srev-entries-"));
    expect(loadConfiguredEntries(dir)).toEqual([]);
    writeFileSync(join(dir, ".srev-entry-points.json"), "{not json");
    expect(loadConfiguredEntries(dir)).toEqual([]);
  });
});

describe("isExportedAt", () => {
  it("detects an export keyword at the definition line", () => {
    const dir = mkdtempSync(join(tmpdir(), "srev-exp-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "const x = 1;\nexport function foo() {}\nfunction bar() {}\n");
    expect(isExportedAt(dir, "src/a.ts", 2)).toBe(true);
    expect(isExportedAt(dir, "src/a.ts", 3)).toBe(false);
  });
  it("returns false for unreadable files", () => {
    expect(isExportedAt("/nonexistent", "nope.ts", 1)).toBe(false);
  });
  it("does not match 'export' as a substring of a method name (e.g. exportData)", () => {
    const dir = mkdtempSync(join(tmpdir(), "srev-exp-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "b.ts"), "class Foo {\n  exportData() {\n    return 1;\n  }\n}\n");
    expect(isExportedAt(dir, "src/b.ts", 2)).toBe(false);
  });
});

describe("pythonEntryReasons", () => {
  const write = (content: string) => {
    const dir = mkdtempSync(join(tmpdir(), "srev-pyentry-"));
    writeFileSync(join(dir, "app.py"), content);
    return dir;
  };

  it("detects http-route decorators above the definition", () => {
    const dir = write('@app.route("/hello")\ndef hello():\n    return "hi"\n');
    // enclosingRange may start at the def line…
    expect(pythonEntryReasons(dir, "app.py", { label: "hello", startLine: 2 })).toEqual(["http-route"]);
    // …or at the decorator line; both must detect.
    expect(pythonEntryReasons(dir, "app.py", { label: "hello", startLine: 1 })).toEqual(["http-route"]);
  });

  it("detects fastapi-style method decorators", () => {
    const dir = write('@router.get("/items")\ndef list_items():\n    return []\n');
    expect(pythonEntryReasons(dir, "app.py", { label: "list_items", startLine: 2 })).toEqual(["http-route"]);
  });

  it("detects mcp tool/resource/prompt decorators", () => {
    const dir = write("@mcp.tool()\ndef execute_sql(q: str):\n    return run(q)\n");
    expect(pythonEntryReasons(dir, "app.py", { label: "execute_sql", startLine: 2 })).toEqual(["tool"]);
  });

  it("detects click/typer command decorators", () => {
    const dir = write("@cli.command()\ndef sync():\n    pass\n");
    expect(pythonEntryReasons(dir, "app.py", { label: "sync", startLine: 2 })).toEqual(["cli"]);
  });

  it("detects a __main__ guard that calls the node", () => {
    const dir = write('def main():\n    pass\n\n\nif __name__ == "__main__":\n    main()\n');
    expect(pythonEntryReasons(dir, "app.py", { label: "main", startLine: 1 })).toEqual(["cli"]);
  });

  it("detects a __main__ guard without PEP8 spacing", () => {
    const dir = write('def main():\n    pass\n\n\nif __name__=="__main__":\n    main()\n');
    expect(pythonEntryReasons(dir, "app.py", { label: "main", startLine: 1 })).toEqual(["cli"]);
  });

  it("ignores unrelated decorators, other functions, and unreadable files", () => {
    const dir = write('@functools.lru_cache\ndef helper():\n    pass\n\n\nif __name__ == "__main__":\n    main()\n');
    expect(pythonEntryReasons(dir, "app.py", { label: "helper", startLine: 2 })).toEqual([]);
    expect(pythonEntryReasons("/nonexistent", "app.py", { label: "x", startLine: 1 })).toEqual([]);
  });

  it("collects stacked decorators and dedupes reasons", () => {
    const dir = write('@app.route("/a")\n@app.route("/b")\ndef multi():\n    pass\n');
    expect(pythonEntryReasons(dir, "app.py", { label: "multi", startLine: 3 })).toEqual(["http-route"]);
  });
});

describe("entryEvidence with detected reasons", () => {
  it("scores detected entries 0.8 and appends detected reasons before configured", () => {
    expect(entryEvidence({ isRoot: true, isExported: false, isConfigured: false, detected: ["tool"] })).toEqual({
      reasons: ["graph-root", "tool"],
      confidence: 0.8,
    });
  });
  it("configured still wins over detected", () => {
    expect(entryEvidence({ isRoot: true, isExported: false, isConfigured: true, detected: ["cli"] })).toEqual({
      reasons: ["graph-root", "cli", "configured"],
      confidence: 1.0,
    });
  });
});

describe("csharpEntryReasons", () => {
  function write(lines: string[]) {
    const root = mkdtempSync(join(tmpdir(), "srev-cs-entry-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "A.cs"), lines.join("\n"));
    return root;
  }
  it("detects controller actions by HTTP verb or Route attributes above the definition", () => {
    const root = write([
      "public class TokenController : ControllerBase",
      "{",
      '    [HttpGet("{userId}")]',
      "    [Authorize]",
      "    public ActionResult<string> Get(string userId) => Ok(userId);",
      "",
      '    [Route("x"), Authorize]',
      "    public IActionResult Route() => Ok();",
      "}",
    ]);
    expect(csharpEntryReasons(root, "src/A.cs", { label: "Get", startLine: 5 })).toEqual(["http-route"]);
    expect(csharpEntryReasons(root, "src/A.cs", { label: "Route", startLine: 8 })).toEqual(["http-route"]);
  });
  it("detects a static Main as a cli entry and stops scanning at non-attribute lines", () => {
    const root = write([
      "[ApiController]",
      "public class Program",
      "{",
      "    public static int Main(string[] args) => 0;",
      "    public void Helper() {}",
      "}",
    ]);
    expect(csharpEntryReasons(root, "src/A.cs", { label: "Main", startLine: 4 })).toEqual(["cli"]);
    expect(csharpEntryReasons(root, "src/A.cs", { label: "Helper", startLine: 5 })).toEqual([]);
  });
  it("returns [] for unreadable files and reuses the line cache", () => {
    expect(csharpEntryReasons("/nonexistent", "src/A.cs", { label: "X", startLine: 1 })).toEqual([]);
    const cache = new Map<string, string[]>([["src/A.cs", ["[HttpPost]", "public void Post() {}"]]]);
    expect(csharpEntryReasons("/nonexistent", "src/A.cs", { label: "Post", startLine: 2 }, cache)).toEqual([
      "http-route",
    ]);
  });
});
