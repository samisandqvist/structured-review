import { describe, it, expect } from "vitest";
import { memberEndLine, synthesizeCsharpSpans } from "../src/graph/csharp-spans.js";
import type { ScipDocument } from "../src/graph/scip.js";

describe("memberEndLine", () => {
  it("ends a block body at the brace that closes the first opening brace", () => {
    expect(memberEndLine(["void A()", "{", "  if (x) { y(); }", "}", "void B() {}"], 0)).toBe(3);
  });
  it("ends an expression-bodied member at its semicolon", () => {
    expect(memberEndLine(["int F(int a) => a + 1;", "int G() => 2;"], 0)).toBe(0);
  });
  it("ends an interface or abstract member at its semicolon", () => {
    expect(memberEndLine(["  string Resolve(string id);", "  string Other();"], 0)).toBe(0);
  });
  it("ignores braces and semicolons inside strings, chars and comments", () => {
    const lines = ["void A() {", '  var s = "}"; // }', "  /* } ; */", "  var c = '}';", "}"];
    expect(memberEndLine(lines, 0)).toBe(4);
  });
  it("handles verbatim strings with doubled quotes", () => {
    expect(memberEndLine(["void A() {", '  var s = @"a""}";', "}"], 0)).toBe(2);
  });
  it("handles raw string literals", () => {
    expect(memberEndLine(["void A() {", '  var s = """', "  }", '  """;', "}"], 0)).toBe(4);
  });
  it("handles interpolation holes containing quotes and braces", () => {
    expect(memberEndLine(['string A(int n) => $"{(n > 0 ? "}" : "{")}";', "int B() => 1;"], 0)).toBe(0);
  });
  it("treats doubled braces in interpolated strings as literals", () => {
    expect(memberEndLine(['string A() => $"{{literal}}";', "int B() => 1;"], 0)).toBe(0);
  });
  it("skips holes in verbatim-interpolated strings and empty string literals", () => {
    expect(memberEndLine(["void A() {", '  var s = $@"{x}" + "" + @$"}";', "}"], 0)).toBe(2);
  });
  it("skips preprocessor directive lines", () => {
    expect(memberEndLine(["void A()", "{", "#if DEBUG", '  Log("{");', "#endif", "}"], 0)).toBe(5);
  });
  it("spans multi-line block comments", () => {
    expect(memberEndLine(["void A() {", "  /* start", "  } still comment", "  */ x();", "}"], 0)).toBe(4);
  });
  it("returns the start line when the member never closes", () => {
    expect(memberEndLine(["void A() {", "  x();"], 0)).toBe(0);
  });
});

describe("synthesizeCsharpSpans", () => {
  const METHOD = "scip-dotnet nuget . . Core/TokenService#Resolve().";
  const PROP = "scip-dotnet nuget . . Core/TokenService#Hits.";
  const SPANNED = "scip-dotnet nuget . . Core/TokenService#Mint().";
  const source = [
    "public class TokenService {",
    "  public int Hits { get; private set; }",
    "  public string Resolve(string id)",
    "  {",
    "    return Mint(id);",
    "  }",
    "  private static string Mint(string id) => id;",
    "}",
  ].join("\n");
  const doc: ScipDocument = {
    relativePath: "src/TokenService.cs",
    occurrences: [
      { symbol: PROP, symbolRoles: 1, range: [1, 13, 17] },
      { symbol: METHOD, symbolRoles: 1, range: [2, 16, 23] },
      { symbol: SPANNED, symbolRoles: 1, range: [6, 24, 28], enclosingRange: [6, 2, 6, 47] },
      { symbol: METHOD, symbolRoles: 0, range: [4, 11, 18] },
      { symbol: "local 0", symbolRoles: 1, range: [4, 4, 5] },
    ],
  };

  it("adds body spans to method definitions only, leaving existing spans and non-methods alone", () => {
    const [out] = synthesizeCsharpSpans([doc], () => source);
    const byIndex = out!.occurrences!;
    expect(byIndex[0]!.enclosingRange).toBeUndefined(); // property
    expect(byIndex[1]!.enclosingRange).toEqual([2, 0, 5, 3]); // Resolve: lines 2..5, "  }" has 3 chars
    expect(byIndex[2]!.enclosingRange).toEqual([6, 2, 6, 47]); // already spanned: untouched
    expect(byIndex[3]!.enclosingRange).toBeUndefined(); // reference, not definition
    expect(byIndex[4]!.enclosingRange).toBeUndefined(); // local
  });
  it("does not mutate its input and leaves non-.cs documents unchanged", () => {
    const before = JSON.stringify(doc);
    const java: ScipDocument = {
      relativePath: "A.java",
      occurrences: [{ symbol: "x#m().", symbolRoles: 1, range: [0, 0, 1] }],
    };
    const out = synthesizeCsharpSpans([doc, java], () => source);
    expect(JSON.stringify(doc)).toBe(before);
    expect(out[1]).toBe(java);
  });
  it("leaves a document unchanged when its source cannot be read", () => {
    const [out] = synthesizeCsharpSpans([doc], () => {
      throw new Error("ENOENT");
    });
    expect(out!.occurrences![1]!.enclosingRange).toBeUndefined();
  });
  it("returns .cs documents with nothing to span untouched", () => {
    const spanned: ScipDocument = {
      relativePath: "B.cs",
      occurrences: [{ symbol: PROP, symbolRoles: 1, range: [0, 0, 1] }],
    };
    expect(synthesizeCsharpSpans([spanned], () => "")[0]).toBe(spanned);
  });
});
