// File ownership and tree navigation for the component map.
import { describe, it, expect } from "vitest";
import { ComponentTree } from "../src/map/ownership.js";
import type { MapComponent } from "../src/map/types.js";

const c = (id: string, parent: string | null, paths: string[], extra: Partial<MapComponent> = {}): MapComponent => ({
  id,
  name: id,
  parent,
  meaning: "",
  paths,
  external: false,
  utility: false,
  ...extra,
});

const tree = new ComponentTree([
  c("app", null, [""]),
  c("ext", null, [], { external: true }),
  c("core", "app", ["src/core/"]),
  c("engine", "core", ["src/core/engine/"]),
  c("wake", "engine", ["src/core/engine/wake.ts"]),
  c("api", "app", ["src/api"]),
  c("gen", "app", ["src/**/*.gen.ts"]),
  c("cfg", "app", ["src/config.ts", "src/core/config.ts"]),
]);

describe("ComponentTree.ownerOf", () => {
  it.each([
    ["src/core/engine/run.ts", "engine"],
    ["src/core/engine/wake.ts", "wake"],
    ["src/core/other.ts", "core"],
    ["src/api/x.ts", "api"],
    ["src/apix.ts", "app"],
    ["src/api", "api"],
    ["src/core/types.gen.ts", "gen"],
    ["src/config.ts", "cfg"],
    ["README.md", "app"],
  ])("%s → %s", (file, owner) => {
    expect(tree.ownerOf(file)).toBe(owner);
  });

  it("prefers the deeper component, then the longer pattern", () => {
    // cfg (depth 1, exact file) against core (depth 1, prefix): the longer pattern wins.
    expect(tree.ownerOf("src/core/config.ts")).toBe("cfg");
  });

  it("returns undefined when nothing claims the file", () => {
    expect(new ComponentTree([c("a", null, ["lib/"])]).ownerOf("src/x.ts")).toBeUndefined();
  });
});

describe("ComponentTree navigation", () => {
  it("lists ancestors self first", () => {
    expect(tree.ancestors("wake")).toEqual(["wake", "engine", "core", "app"]);
  });

  it("finds the lowest common ancestor, null across roots", () => {
    expect(tree.lca("wake", "api")).toBe("app");
    expect(tree.lca("wake", "engine")).toBe("engine");
    expect(tree.lca("wake", "ext")).toBeNull();
  });

  it("finds the child toward a descendant", () => {
    expect(tree.childToward("app", "wake")).toBe("core");
    expect(tree.childToward(null, "wake")).toBe("app");
    expect(tree.childToward("engine", "engine")).toBeUndefined();
    expect(tree.childToward("api", "wake")).toBeUndefined();
  });

  it("answers within, children and parents", () => {
    expect(tree.within("wake", "core")).toBe(true);
    expect(tree.within("api", "core")).toBe(false);
    expect(tree.childrenOf("engine").map((x) => x.id)).toEqual(["wake"]);
    expect(tree.childrenOf(null).map((x) => x.id)).toEqual(["app", "ext"]);
    expect(tree.parentOf("core")).toBe("app");
    expect(tree.parentOf("missing")).toBeNull();
    expect(tree.get("api")?.paths).toEqual(["src/api"]);
  });

  it("lists the path from a descendant up to an ancestor as parent/child steps", () => {
    expect(tree.steps("wake", "core")).toEqual([
      { outer: "engine", inner: "wake" },
      { outer: "core", inner: "engine" },
    ]);
    expect(tree.steps("core", "core")).toEqual([]);
  });
});
