import { describe, it, expect } from "vitest";
import { globToRegExp, resolveOrphanFiles } from "../src/globs.js";

describe("globToRegExp", () => {
  it("** crosses directories", () => {
    expect(globToRegExp("docs/**").test("docs/a/b.md")).toBe(true);
    expect(globToRegExp("docs/**").test("docs/a.md")).toBe(true);
    expect(globToRegExp("docs/**").test("src/a.md")).toBe(false);
  });
  it("* stays within a segment", () => {
    expect(globToRegExp("*.md").test("README.md")).toBe(true);
    expect(globToRegExp("*.md").test("docs/x.md")).toBe(false);
    expect(globToRegExp("packages/*/package.json").test("packages/web/package.json")).toBe(true);
    expect(globToRegExp("packages/*/package.json").test("packages/web/src/package.json")).toBe(false);
  });
  it("? matches one non-slash char; regex specials stay literal", () => {
    expect(globToRegExp("a?.ts").test("ab.ts")).toBe(true);
    expect(globToRegExp("a?.ts").test("a/.ts")).toBe(false);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
    expect(globToRegExp("a+b.txt").test("a+b.txt")).toBe(true);
    expect(globToRegExp("a+b.txt").test("aab.txt")).toBe(false);
  });
  it("matches whole paths only", () => {
    expect(globToRegExp("b.md").test("docs/b.md")).toBe(false);
    expect(globToRegExp("docs").test("docs/b.md")).toBe(false);
  });
});

describe("resolveOrphanFiles", () => {
  const orphans = [
    { stableId: "d1", file: "docs/a.md" },
    { stableId: "d2", file: "docs/b.md" },
    { stableId: "c1", file: "package.json" },
  ];

  it("expands globs into orphanStableIds after explicit ids", () => {
    const { units, emptyUnits } = resolveOrphanFiles(
      [{ kind: "orphans", label: "docs", orphanFiles: ["docs/**"] }],
      orphans
    );
    expect(units[0].orphanStableIds).toEqual(["d1", "d2"]);
    expect(emptyUnits).toEqual([]);
  });

  it("keeps explicit ids first and appends glob matches", () => {
    const { units } = resolveOrphanFiles(
      [{ kind: "orphans", label: "mix", orphanStableIds: ["c1"], orphanFiles: ["docs/a.*"] }],
      orphans
    );
    expect(units[0].orphanStableIds).toEqual(["c1", "d1"]);
  });

  it("first unit wins on overlapping globs; explicit claims beat globs", () => {
    const { units } = resolveOrphanFiles(
      [
        { kind: "orphans", label: "one", orphanStableIds: ["d2"] },
        { kind: "orphans", label: "docs", orphanFiles: ["docs/**"] },
        { kind: "orphans", label: "rest", orphanFiles: ["**"] },
      ],
      orphans
    );
    expect(units[1].orphanStableIds).toEqual(["d1"]);
    expect(units[2].orphanStableIds).toEqual(["c1"]);
  });

  it("leaves flow units and glob-less orphan units untouched", () => {
    const flowUnit = { kind: "flow" as const, label: "f", flowEntryStableIds: ["e"] };
    const plain = { kind: "orphans" as const, label: "p", orphanStableIds: ["c1"] };
    const { units } = resolveOrphanFiles([flowUnit, plain], orphans);
    expect(units[0]).toBe(flowUnit);
    expect(units[1]).toBe(plain);
  });

  it("reports units whose globs matched nothing", () => {
    const { emptyUnits } = resolveOrphanFiles(
      [{ kind: "orphans", label: "nope", orphanFiles: ["nothing/**"] }],
      orphans
    );
    expect(emptyUnits).toEqual(["nope"]);
  });
});
