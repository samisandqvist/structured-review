// ELK graph construction for one level and the two-pass layout.
import { describe, it, expect, vi } from "vitest";
import ELK from "elkjs/lib/elk.bundled.js";
import { buildLevel } from "../src/map/levels.js";
import { elkGraph, layoutLevel, PORT_PITCH, PORT_TOP } from "../src/map/layout.js";
import { measureText } from "../src/map/measure.js";
import { fixtureMap } from "./map-fixture.js";

const map = fixtureMap();
const measure = (text: string) => text.length * 7;

describe("measureText", () => {
  it("estimates from the font size without a canvas", () => {
    expect(measureText("abcd", "500 10px Sans")).toBe(24);
    expect(measureText("ab", "bold Sans")).toBe(Math.ceil(13 * 0.6 * 2));
  });
});

describe("elkGraph", () => {
  it("lays out the system level as plain leaves", () => {
    const g = elkGraph(map, buildLevel(map, null), null, measure);
    expect(g.children!.map((c) => c.id)).toEqual(["operators", "orchestrator", "feeds"]);
    expect(g.edges).toHaveLength(2);
    expect(g.children![1]!.layoutOptions!["elk.portConstraints"]).toBe("FIXED_SIDE");
  });

  it("puts the opened component in a frame with inner edges and boundary ports, neighbours outside", () => {
    const g = elkGraph(map, buildLevel(map, "orchestrator"), null, measure);
    const frame = g.children!.find((c) => c.id === "orchestrator")!;
    expect(frame.children!.map((c) => c.id)).toEqual(["api", "core", "store"]);
    expect(frame.edges!.length).toBe(6);
    expect(frame.ports!.map((p) => p.id).sort()).toEqual([
      "orchestrator|item-feed|require",
      "orchestrator|job-api|provide",
    ]);
    expect(g.children!.map((c) => c.id).sort()).toEqual(["feeds", "operators", "orchestrator"]);
    expect(g.edges).toHaveLength(2);
  });

  it("places provided ports west and required east in the given order with fixed positions", () => {
    const level = buildLevel(map, "orchestrator");
    const order = new Map([
      ["store|writes|provide", 0],
      ["store|reads|provide", 1],
    ]);
    const store = elkGraph(map, level, order, measure)
      .children!.find((c) => c.id === "orchestrator")!
      .children!.find((c) => c.id === "store")!;
    expect(store.layoutOptions!["elk.portConstraints"]).toBe("FIXED_POS");
    expect(store.ports!.map((p) => [p.id, p.x, p.y])).toEqual([
      ["store|writes|provide", -16, PORT_TOP - 6],
      ["store|reads|provide", -16, PORT_TOP + PORT_PITCH - 6],
    ]);
    const api = elkGraph(map, level, order, measure)
      .children!.find((c) => c.id === "orchestrator")!
      .children!.find((c) => c.id === "api")!;
    expect(api.ports!.filter((p) => p.x === api.width).length).toBe(2);
  });
});

describe("layoutLevel", () => {
  it("positions every node and routes every edge", async () => {
    const level = buildLevel(map, "orchestrator");
    const out = await layoutLevel(map, level, new ELK(), measure);
    const frame = out.children!.find((c) => c.id === "orchestrator")!;
    expect(frame.children!.every((c) => typeof c.x === "number" && typeof c.y === "number")).toBe(true);
    expect([...(out.edges ?? []), ...(frame.edges ?? [])].every((e) => (e.sections?.length ?? 0) > 0)).toBe(true);
  });
});

describe("elkGraph for a component without interfaces", () => {
  it("draws a frame and parts without ports", () => {
    const m = fixtureMap();
    m.components.push(
      { ...m.components[3]!, id: "idle", name: "Idle", parent: "orchestrator" },
      { ...m.components[3]!, id: "idle-part", name: "Idle part", parent: "idle" },
    );
    const g = elkGraph(m, buildLevel(m, "idle"), null, measure);
    const frame = g.children!.find((c) => c.id === "idle")!;
    expect(frame.ports).toEqual([]);
    expect(frame.children![0]!.ports).toEqual([]);
  });
});

describe("measureText with a canvas", () => {
  it("measures with the 2D context and reuses it", async () => {
    vi.resetModules();
    const ctx = { font: "", measureText: (t: string) => ({ width: t.length * 5.2 }) };
    const create = vi
      .spyOn(document, "createElement")
      .mockReturnValue({ getContext: () => ctx } as unknown as HTMLElement);
    const { measureText: measured } = await import("../src/map/measure.js");
    expect(measured("abc", "11px X")).toBe(16);
    expect(measured("abcd", "12px Y")).toBe(21);
    expect(ctx.font).toBe("12px Y");
    expect(create).toHaveBeenCalledTimes(1);
    create.mockRestore();
  });

  it("falls back when creating a canvas throws", async () => {
    vi.resetModules();
    const create = vi.spyOn(document, "createElement").mockImplementation(() => {
      throw new Error("no canvas");
    });
    const { measureText: measured } = await import("../src/map/measure.js");
    expect(measured("ab", "10px X")).toBe(12);
    create.mockRestore();
  });
});
