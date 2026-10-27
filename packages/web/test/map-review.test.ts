// A review's change on the map: what is drawn, how connectors are marked and
// where the changed review items sit.
import { describe, it, expect } from "vitest";
import { buildLevel } from "../src/map/levels.js";
import { drawnMap, edgeChanges, itemCounts, placeItems } from "../src/map/review.js";
import { fixtureChange, fixtureMap, fixtureReview } from "./map-fixture.js";

const { nodes: NODES, units: UNITS, flows: FLOWS } = fixtureReview();

const reviewMap = () => ({ ...fixtureMap(), change: fixtureChange() });

describe("drawnMap", () => {
  it("leaves a map without a change as it is", () => {
    const map = fixtureMap();
    expect(drawnMap(map)).toBe(map);
  });

  it("adds new surfaces as interfaces and the change's delegations", () => {
    const drawn = drawnMap(reviewMap());
    expect(drawn.interfaces.at(-1)).toMatchObject({
      id: "new:store:src/store/cache.ts:warm",
      name: "warm",
      provider: "store",
      requirers: ["core"],
    });
    expect(drawn.delegations).toContainEqual(fixtureChange().delegations[0]);
  });

  it("adds the requirer of a new crossing", () => {
    const base = fixtureMap();
    base.interfaces = base.interfaces.map((i) =>
      i.id === "reads" ? { ...i, requirers: ["core"], sites: i.sites.filter((s) => s.requirer !== "api") } : i,
    );
    const map = {
      ...base,
      change: {
        ...fixtureChange(),
        crossings: [{ interface: "reads", requirer: "api", status: "new" as const, added: [], removed: [] }],
      },
    };
    const drawn = drawnMap(map);
    expect(drawn.interfaces.find((i) => i.id === "reads")!.requirers).toEqual(["core", "api"]);
    const level = buildLevel(drawn, "orchestrator");
    const marks = edgeChanges(drawn, level);
    const edge = [...level.edges.values()].find((e) => e.iface === "reads" && e.from.startsWith("api|"))!;
    expect(marks.get(edge.id)).toBe("new");
  });
});

describe("edgeChanges", () => {
  const drawn = drawnMap(reviewMap());

  it("marks crossings and new surfaces where siblings connect", () => {
    const level = buildLevel(drawn, "orchestrator");
    const marks = edgeChanges(drawn, level);
    const byIface = (iface: string, from: string) =>
      [...level.edges.values()].find((e) => e.iface === iface && e.from.startsWith(`${from}|`))!.id;
    expect(marks.get(byIface("writes", "api"))).toBe("changed");
    expect(marks.get(byIface("new:store:src/store/cache.ts:warm", "core"))).toBe("new");
    expect(marks.has(byIface("reads", "core"))).toBe(false);
  });

  it("marks removed connectors and new delegations inside a part", () => {
    const level = buildLevel(drawn, "core");
    const marks = edgeChanges(drawn, level);
    const edge = (iface: string) => [...level.edges.values()].find((e) => e.iface === iface)!.id;
    expect(marks.get(edge("help"))).toBe("removed");
    expect(marks.get(edge("new:store:src/store/cache.ts:warm"))).toBe("new");
    expect(marks.has(edge("reads"))).toBe(false);
  });

  it("marks nothing without a change", () => {
    const map = fixtureMap();
    expect(edgeChanges(map, buildLevel(map, "orchestrator")).size).toBe(0);
  });
});

describe("placeItems", () => {
  const placed = placeItems(fixtureMap(), fixtureChange(), NODES, UNITS, FLOWS);

  it("puts changed items in their component in walk order, tests with what they test", () => {
    expect([...placed.keys()].sort()).toEqual(["engine", "orchestrator", "store"]);
    expect(placed.get("engine")!.map((n) => n.id)).toEqual(["n5", "n1", "t1"]);
    expect(placed.get("store")!.map((n) => n.id)).toEqual(["n2"]);
    expect(placed.get("orchestrator")!.map((n) => n.id)).toEqual(["n3"]);
  });

  it("places tests nothing attaches by their path", () => {
    const loose = placeItems(fixtureMap(), fixtureChange(), NODES, [], []);
    expect(loose.get("")!.map((n) => n.id)).toEqual(["t1"]);
    expect(loose.get("engine")!.map((n) => n.id)).toEqual(["n1", "n5"]);
  });

  it("counts changed and reviewed items up the tree", () => {
    const counts = itemCounts(fixtureMap(), placed);
    expect(counts.get("engine")).toEqual({ changed: 3, reviewed: 1 });
    expect(counts.get("core")).toEqual({ changed: 3, reviewed: 1 });
    expect(counts.get("store")).toEqual({ changed: 1, reviewed: 1 });
    expect(counts.get("orchestrator")).toEqual({ changed: 5, reviewed: 2 });
    expect(counts.has("api")).toBe(false);
  });
});

describe("review fixes", () => {
  it("marks delegations inside a part by what changed in that part", () => {
    const change = {
      ...fixtureChange(),
      crossings: [
        {
          interface: "writes",
          requirer: "core",
          status: "changed" as const,
          added: [{ ...fixtureChange().crossings[1]!.added[0]!, component: "engine", requirer: "core" }],
          removed: [],
        },
      ],
      removedDelegations: [{ interface: "reads", side: "required" as const, outer: "core", inner: "engine" }],
    };
    const drawn = drawnMap({ ...fixtureMap(), change });
    const level = buildLevel(drawn, "core");
    const marks = edgeChanges(drawn, level);
    const edge = (iface: string) =>
      [...level.edges.values()].find((e) => e.iface === iface && e.from.startsWith("engine|"))!.id;
    expect(marks.get(edge("reads"))).toBe("removed");
    expect(marks.get(edge("writes"))).toBe("changed");
    expect(marks.has(edge("item-feed"))).toBe(false);
  });

  it("places items of a hidden utility on its nearest visible ancestor", () => {
    const nodes = [...NODES, { ...NODES[0]!, id: "n6", stableId: "s-n6", file: "src/infra/log.ts" }];
    const change = { ...fixtureChange(), nodeComponents: { ...fixtureChange().nodeComponents, n6: "infra" } };
    const placed = placeItems(fixtureMap(), change, nodes, [], []);
    expect(placed.get("orchestrator")!.map((n) => n.id)).toEqual(["n6", "n3"]);
    expect(placed.has("infra")).toBe(false);
  });
});
