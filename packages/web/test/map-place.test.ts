import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startingPlace } from "../src/map/MapPage.js";
import { recalledPlace, rememberPlace } from "../src/map/place.js";
import { fixtureMap } from "./map-fixture.js";

const map = fixtureMap();
const zoomed = { x: 3, y: 4, k: 2 };

beforeEach(() => window.sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("startingPlace", () => {
  it("opens the default level at its default view when nothing is remembered", () => {
    expect(startingPlace(map, "s1", "?session=s1")).toEqual({
      level: "orchestrator",
      selection: null,
      transform: null,
      recalled: false,
    });
  });

  it("returns to the remembered place when the URL names no level or the same one", () => {
    const place = { level: "core", selection: { type: "node" as const, id: "engine" }, transform: zoomed };
    rememberPlace("s1", place);
    expect(startingPlace(map, "s1", "?session=s1")).toEqual({ ...place, recalled: true });
    expect(startingPlace(map, "s1", "?session=s1&level=core")).toEqual({ ...place, recalled: true });
    expect(startingPlace(map, "s2", "?session=s2").recalled).toBe(false);
  });

  it("remembers the system level", () => {
    rememberPlace("s1", { level: null, selection: null, transform: zoomed });
    expect(startingPlace(map, "s1", "?session=s1")).toMatchObject({ level: null, transform: zoomed });
  });

  it("drops a remembered level the map no longer has", () => {
    rememberPlace("s1", { level: "gone", selection: { type: "node", id: "x" }, transform: zoomed });
    expect(startingPlace(map, "s1", "?session=s1")).toEqual({
      level: "orchestrator",
      selection: null,
      transform: null,
      recalled: false,
    });
  });
});

describe("place storage", () => {
  it("forgets nothing and recalls nothing when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => rememberPlace("s1", { level: "core", selection: null, transform: null })).not.toThrow();
    expect(recalledPlace("s1")).toBeNull();
  });
});
