// Parsing a component model: shape, defaults and the structural rules that
// must hold before a model can be resolved against the index.
import { describe, it, expect } from "vitest";
import { parseMapModel } from "../src/map/model.js";

function example() {
  return {
    title: "Job orchestrator",
    components: [
      { id: "orchestrator", name: "Job orchestrator", parent: null, paths: [""], meaning: "Runs jobs" },
      { id: "feeds", name: "Feed service", parent: null, external: true, meaning: "Publishes items" },
      { id: "store", name: "Persistence", parent: "orchestrator", paths: ["src/store/"], meaning: "Facade" },
      { id: "api", name: "API", parent: "orchestrator", paths: ["src/api/"], meaning: "Operator API" },
      {
        id: "infra",
        name: "Infrastructure",
        parent: "orchestrator",
        paths: ["src/lib/"],
        utility: true,
        meaning: "Helpers",
      },
    ],
    interfaces: [
      {
        id: "read-models",
        name: "Read models",
        provider: "store",
        requirers: ["api"],
        meaning: "Reads",
        bind: ["getJob"],
      },
      {
        id: "feed-hook",
        name: "Feed notification",
        provider: "orchestrator",
        requirers: ["feeds"],
        kind: "webhook",
        meaning: "POST /hooks/feed",
        evidence: ["src/api/hooks.ts"],
      },
    ],
    undeclared: [{ interface: "read-models", requirer: "api", reason: "The header says so" }],
  };
}
type Example = ReturnType<typeof example>;

function issuesOf(mutate: (m: Example) => void): string[] {
  const m = example();
  mutate(m);
  return parseMapModel(m).issues.map((i) => i.message);
}
const component = (m: Example, id: string) => m.components.find((c) => c.id === id)! as Record<string, unknown>;
const iface = (m: Example, id: string) => m.interfaces.find((i) => i.id === id)! as Record<string, unknown>;

describe("parseMapModel", () => {
  it("parses the spec example without issues", () => {
    const { model, issues } = parseMapModel(example());
    expect(issues).toEqual([]);
    expect(model.components).toHaveLength(5);
    expect(model.interfaces[1]!.kind).toBe("webhook");
  });

  it("applies defaults", () => {
    const { model } = parseMapModel({
      title: "t",
      components: [{ id: "a", name: "A", parent: null, paths: [""], meaning: "m" }],
      interfaces: [],
    });
    expect(model.components[0]).toEqual({
      id: "a",
      name: "A",
      parent: null,
      paths: [""],
      meaning: "m",
      external: false,
      utility: false,
    });
    expect(model.undeclared).toEqual([]);
  });

  it("reports shape errors and returns an empty model", () => {
    const { model, issues } = parseMapModel({ title: 3, components: "x" });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.rule === "model")).toBe(true);
    expect(model.components).toEqual([]);
  });
});

describe("parseMapModel structural rules for components", () => {
  it.each<[string, (m: Example) => void, string]>([
    ["duplicate component", (m) => m.components.push({ ...m.components[2]! }), "duplicate component id 'store'"],
    ["invalid id", (m) => (component(m, "store").id = "Store!"), "invalid component id 'Store!'"],
    ["reserved id", (m) => (component(m, "store").id = "system"), "reserved component id 'system'"],
    ["unknown parent", (m) => (component(m, "store").parent = "nope"), "component 'store' has unknown parent 'nope'"],
    [
      "cycle",
      (m) => {
        component(m, "orchestrator").parent = "store";
      },
      "parent cycle through 'orchestrator'",
    ],
    ["external with paths", (m) => (component(m, "feeds").paths = ["x/"]), "external component 'feeds' has paths"],
    ["external utility", (m) => (component(m, "feeds").utility = true), "external component 'feeds' is a utility"],
    ["external with children", (m) => (component(m, "api").parent = "feeds"), "external component 'feeds' has parts"],
    ["no paths", (m) => (component(m, "api").paths = []), "component 'api' needs paths"],
    [
      "utility with children",
      (m) => m.components.push({ id: "x", name: "X", parent: "infra", paths: ["src/lib/x/"], meaning: "m" }),
      "utility 'infra' has parts",
    ],
  ])("%s", (_name, mutate, message) => {
    expect(issuesOf(mutate)).toContain(message);
  });

  it("reports a model with no root component", () => {
    const issues = issuesOf((m) => {
      m.components = m.components.filter((c) => c.parent !== null);
      for (const c of m.components) c.parent = "store";
      component(m, "store").parent = "api";
      component(m, "api").parent = "store";
      m.interfaces = [];
      m.undeclared = [];
    });
    expect(issues).toContain("the model has no root component");
  });
});

describe("parseMapModel structural rules for interfaces", () => {
  it.each<[string, (m: Example) => void, string]>([
    ["duplicate interface", (m) => m.interfaces.push({ ...m.interfaces[0]! }), "duplicate interface id 'read-models'"],
    ["invalid interface id", (m) => (iface(m, "read-models").id = "Bad Id"), "invalid interface id 'Bad Id'"],
    [
      "unknown provider",
      (m) => (iface(m, "read-models").provider = "nope"),
      "interface 'read-models' has unknown provider 'nope'",
    ],
    [
      "unknown requirer",
      (m) => (iface(m, "read-models").requirers = ["nope"]),
      "interface 'read-models' has unknown requirer 'nope'",
    ],
    [
      "requirer is provider",
      (m) => (iface(m, "read-models").requirers = ["store"]),
      "interface 'read-models' lists its provider 'store' as a requirer",
    ],
    [
      "requirer not a sibling",
      (m) => (iface(m, "read-models").requirers = ["feeds"]),
      "requirer 'feeds' of interface 'read-models' is not a sibling of provider 'store'",
    ],
    [
      "utility provider",
      (m) => (iface(m, "read-models").provider = "infra"),
      "utility 'infra' cannot provide interface 'read-models'",
    ],
    [
      "utility requirer",
      (m) => (iface(m, "read-models").requirers = ["infra"]),
      "utility 'infra' cannot require interface 'read-models'",
    ],
    [
      "in-process without bind",
      (m) => (iface(m, "read-models").bind = []),
      "interface 'read-models' needs bind entries",
    ],
    [
      "in-process with evidence",
      (m) => (iface(m, "read-models").evidence = ["x.ts"]),
      "in-process interface 'read-models' cannot have evidence; set kind for a cross-process interface",
    ],
    [
      "cross-process with bind",
      (m) => (iface(m, "feed-hook").bind = ["x"]),
      "cross-process interface 'feed-hook' cannot have bind entries",
    ],
    [
      "external provider in-process",
      (m) =>
        m.interfaces.push({
          id: "pull",
          name: "Pull",
          provider: "feeds",
          requirers: ["orchestrator"],
          meaning: "m",
          bind: ["x"],
        }),
      "external 'feeds' can only provide cross-process interfaces ('pull')",
    ],
  ])("%s", (_name, mutate, message) => {
    expect(issuesOf(mutate)).toContain(message);
  });
});

describe("parseMapModel structural rules for undeclared uses", () => {
  it.each<[string, (m: Example) => void, string]>([
    [
      "unknown interface",
      (m) => (m.undeclared[0]!.interface = "nope"),
      "undeclared use names unknown interface 'nope'",
    ],
    [
      "unknown requirer",
      (m) => (m.undeclared[0]!.requirer = "nope"),
      "undeclared use of 'read-models' names unknown component 'nope'",
    ],
    ["empty reason", (m) => (m.undeclared[0]!.reason = " "), "undeclared use of 'read-models' by 'api' needs a reason"],
  ])("%s", (_name, mutate, message) => {
    expect(issuesOf(mutate)).toContain(message);
  });
});
