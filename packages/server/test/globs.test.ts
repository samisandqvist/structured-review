import { describe, it, expect } from "vitest";
import { matchGlob, resolveOrphanFiles } from "../src/globs.js";

// Conformance suite for the documented glob semantics. Matching is delegated
// to node:path matchesGlob (experimental) — if an upstream Node change shifts
// behavior, these cases catch it.
describe("matchGlob", () => {
  it("** crosses directories", () => {
    expect(matchGlob("docs/a/b.md", "docs/**")).toBe(true);
    expect(matchGlob("docs/a.md", "docs/**")).toBe(true);
    expect(matchGlob("src/a.md", "docs/**")).toBe(false);
  });
  it("* stays within a segment", () => {
    expect(matchGlob("README.md", "*.md")).toBe(true);
    expect(matchGlob("docs/x.md", "*.md")).toBe(false);
    expect(matchGlob("packages/web/package.json", "packages/*/package.json")).toBe(true);
    expect(matchGlob("packages/web/src/package.json", "packages/*/package.json")).toBe(false);
  });
  it("? matches one non-slash char; regex specials stay literal", () => {
    expect(matchGlob("ab.ts", "a?.ts")).toBe(true);
    expect(matchGlob("a/.ts", "a?.ts")).toBe(false);
    expect(matchGlob("axb", "a.b")).toBe(false);
    expect(matchGlob("a+b.txt", "a+b.txt")).toBe(true);
    expect(matchGlob("aab.txt", "a+b.txt")).toBe(false);
  });
  it("matches whole paths only", () => {
    expect(matchGlob("docs/b.md", "b.md")).toBe(false);
    expect(matchGlob("docs/b.md", "docs")).toBe(false);
  });
  it("wildcards match dotfiles (issue #9)", () => {
    expect(matchGlob("documentation-gathering/.env.example", "documentation-gathering/*")).toBe(true);
    expect(matchGlob(".gitignore", "*")).toBe(true);
    expect(matchGlob("a/.github/workflows/ci.yml", "a/**")).toBe(true);
    expect(matchGlob(".env", "?env")).toBe(true);
  });
  it("literal-dot patterns still require the dot", () => {
    expect(matchGlob(".env", "env*")).toBe(false);
    expect(matchGlob(".env.example", ".env*")).toBe(true);
    expect(matchGlob("env.example", ".env*")).toBe(false);
    expect(matchGlob(".envrc", ".*")).toBe(true);
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
      orphans,
    );
    expect(units[0].orphanStableIds).toEqual(["d1", "d2"]);
    expect(emptyUnits).toEqual([]);
  });

  it("keeps explicit ids first and appends glob matches", () => {
    const { units } = resolveOrphanFiles(
      [{ kind: "orphans", label: "mix", orphanStableIds: ["c1"], orphanFiles: ["docs/a.*"] }],
      orphans,
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
      orphans,
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

  it("leaves an orphan unit with no selector untouched", () => {
    const empty = { kind: "orphans" as const, label: "empty" };
    const { units, emptyUnits } = resolveOrphanFiles([empty], orphans);
    expect(units[0]).toBe(empty);
    expect(emptyUnits).toEqual([]);
  });

  it("reports units whose globs matched nothing", () => {
    const { emptyUnits } = resolveOrphanFiles(
      [{ kind: "orphans", label: "nope", orphanFiles: ["nothing/**"] }],
      orphans,
    );
    expect(emptyUnits).toEqual(["nope"]);
  });
});
