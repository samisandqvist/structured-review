// One level of the component map: the opened component's parts, its boundary
// ports, the neighbours it connects to and the connectors between them.
import { describe, it, expect } from "vitest";
import {
  buildLevel,
  defaultLevel,
  highlighted,
  undeclaredFindings,
  visibleChildren,
  levelTrail,
} from "../src/map/levels.js";
import { fixtureMap } from "./map-fixture.js";

const map = fixtureMap();
const edges = (level: ReturnType<typeof buildLevel>) =>
  [...level.edges.values()]
    .map((e) => `${e.from} > ${e.to} ${e.kind}${e.crossProcess ? " xp" : ""}${e.inside ? " in" : ""}`)
    .sort();

describe("visibleChildren and defaultLevel", () => {
  it("hides utilities", () => {
    expect(visibleChildren(map, "orchestrator").map((c) => c.id)).toEqual(["api", "core", "store"]);
    expect(visibleChildren(map, null).map((c) => c.id)).toEqual(["operators", "orchestrator", "feeds"]);
  });

  it("opens the only internal root when it has parts", () => {
    expect(defaultLevel(map)).toBe("orchestrator");
    const flat = { ...map, components: map.components.filter((c) => c.parent === null) };
    expect(defaultLevel(flat)).toBeNull();
  });

  it("lists the breadcrumb trail", () => {
    expect(levelTrail(map, "engine")).toEqual(["orchestrator", "core", "engine"]);
    expect(levelTrail(map, null)).toEqual([]);
  });
});

describe("buildLevel", () => {
  it("draws the system level with external systems and cross-process connectors", () => {
    const level = buildLevel(map, null);
    expect(level.children).toEqual(["operators", "orchestrator", "feeds"]);
    expect(level.neighbors).toEqual([]);
    expect(edges(level)).toEqual([
      "operators|job-api|require > orchestrator|job-api|provide assembly xp",
      "orchestrator|item-feed|require > feeds|item-feed|provide assembly xp",
    ]);
  });

  it("draws a component's inside with boundary ports, neighbours and delegation", () => {
    const level = buildLevel(map, "orchestrator");
    expect(level.children).toEqual(["api", "core", "store"]);
    expect(level.neighbors.sort()).toEqual(["feeds", "operators"]);
    expect(level.ports.get("orchestrator|job-api|provide")).toMatchObject({ boundary: true, role: "provide" });
    expect(edges(level)).toEqual([
      "api|reads|require > store|reads|provide assembly in",
      "api|writes|require > store|writes|provide undeclared in",
      "core|item-feed|require > orchestrator|item-feed|require delegate xp in",
      "core|reads|require > store|reads|provide assembly in",
      "core|writes|require > store|writes|provide assembly in",
      "operators|job-api|require > orchestrator|job-api|provide assembly xp",
      "orchestrator|item-feed|require > feeds|item-feed|provide assembly xp",
      "orchestrator|job-api|provide > api|job-api|provide delegate xp in",
    ]);
  });

  it("draws two levels deep with sibling neighbours and ports delegated from the level above", () => {
    const level = buildLevel(map, "core");
    expect(level.children).toEqual(["engine", "support"]);
    expect(level.neighbors.sort()).toEqual(["store"]);
    expect(edges(level)).toEqual([
      "core|reads|require > store|reads|provide assembly",
      "core|writes|require > store|writes|provide assembly",
      "engine|help|require > support|help|provide assembly in",
      "engine|item-feed|require > core|item-feed|require delegate xp in",
      "engine|reads|require > core|reads|require delegate in",
      "engine|writes|require > core|writes|require delegate in",
    ]);
  });

  it("marks a delegated requirement undeclared when the part's call sites are", () => {
    const m = fixtureMap();
    const reads = m.interfaces.find((i) => i.id === "reads")!;
    reads.requirers = ["api"];
    reads.sites[1]!.undeclared = true;
    const level = buildLevel(m, "core");
    expect(level.edges.get("engine|reads|require>core|reads|require")!.kind).toBe("undeclared");
    expect(level.edges.get("core|reads|require>store|reads|provide")!.kind).toBe("undeclared");
  });

  it("collects undeclared findings", () => {
    expect(undeclaredFindings(map).map((f) => `${f.requirer} ${f.iface.id} ${f.sites.length}`)).toEqual([
      "api writes 1",
    ]);
  });
});

describe("highlighted", () => {
  const level = buildLevel(map, "orchestrator");

  it("highlights an interface's ports and edges and keeps their nodes", () => {
    const { hl, keep } = highlighted(level, { type: "iface", id: "reads" });
    expect([...hl].sort()).toEqual([
      "api|reads|require",
      "api|reads|require>store|reads|provide",
      "core|reads|require",
      "core|reads|require>store|reads|provide",
      "store|reads|provide",
    ]);
    expect([...keep].sort()).toEqual(["api", "core", "store"]);
  });

  it("highlights a node's connectors and keeps the nodes on their other end", () => {
    const { hl, keep } = highlighted(level, { type: "node", id: "api" });
    expect(hl.has("api")).toBe(true);
    expect(hl.has("orchestrator|job-api|provide>api|job-api|provide")).toBe(true);
    expect([...keep].sort()).toEqual(["api", "orchestrator", "store"]);
  });

  it("highlights nothing without a selection", () => {
    expect(highlighted(level, null).hl.size).toBe(0);
  });
});
