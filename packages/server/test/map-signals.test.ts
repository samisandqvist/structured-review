// Explicit signals read from source text: module header comments, route and
// tool registrations, and script entry points.
import { describe, it, expect } from "vitest";
import { entryPointReason, headerComment, registrations } from "../src/map/signals.js";

describe("headerComment", () => {
  it.each([
    [
      "line comments",
      "// Owns all job state.\n// Nothing else writes.\nexport const x = 1;\n",
      "a.ts",
      "Owns all job state. Nothing else writes.",
    ],
    [
      "a block comment after a shebang",
      "#!/usr/bin/env node\n\n/**\n * The CLI.\n * Thin wrapper.\n */\nrun();\n",
      "cli.ts",
      "The CLI. Thin wrapper.",
    ],
    ["a one-line block comment", "/* tiny */\n", "a.js", "tiny"],
    ["a Python docstring", '"""Runs jobs.\n\nOne per tick.\n"""\nimport os\n', "a.py", "Runs jobs. One per tick."],
    ["a one-line Python docstring", "'''Short.'''\n", "a.py", "Short."],
    ["Python hash comments", "# Shared helpers.\nimport os\n", "a.py", "Shared helpers."],
  ])("reads %s", (_name, source, file, expected) => {
    expect(headerComment(source, file)).toBe(expected);
  });

  it("returns undefined when code comes first", () => {
    expect(headerComment("import x from 'y';\n// late\n", "a.ts")).toBeUndefined();
    expect(headerComment("", "a.py")).toBeUndefined();
  });

  it("does not treat a TypeScript hash line as a comment", () => {
    expect(headerComment("#private = 1;\n", "a.ts")).toBeUndefined();
  });
});

describe("registrations", () => {
  it("finds HTTP routes and tool registrations in TypeScript", () => {
    const src = [
      'app.post("/hooks/feed", handler);',
      "router.get(`/jobs/:id`, show);",
      'server.tool("create_job", schema, run);',
      "list.get(0);",
      'map.get("key");',
    ].join("\n");
    expect(registrations(src, "src/api.ts")).toEqual([
      { line: 1, text: 'app.post("/hooks/feed", handler);' },
      { line: 2, text: "router.get(`/jobs/:id`, show);" },
      { line: 3, text: 'server.tool("create_job", schema, run);' },
    ]);
  });

  it("finds decorators and route rules in Python", () => {
    const src = [
      '@app.get("/jobs")',
      "def jobs(): ...",
      '@router.post("/x")',
      'app.add_url_rule("/a", view_func=a)',
      "@staticmethod",
    ].join("\n");
    expect(registrations(src, "app/routes.py").map((r) => r.line)).toEqual([1, 3, 4]);
  });

  it("truncates long lines", () => {
    const text = `app.get("/x", ${"a".repeat(300)});`;
    expect(registrations(text, "a.ts")[0]!.text).toHaveLength(160);
  });
});

describe("entryPointReason", () => {
  it("detects a __main__ guard and __main__.py", () => {
    expect(entryPointReason('if __name__ == "__main__":\n    main()\n', "app/cli.py")).toBe(
      "runs as a script (__main__ guard)",
    );
    expect(entryPointReason("main()\n", "app/__main__.py")).toBe("package entry point (__main__.py)");
    expect(entryPointReason("main()\n", "app/x.py")).toBeUndefined();
  });
});
