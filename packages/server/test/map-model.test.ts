// Parsing a component model: shape, defaults and the structural rules that
// must hold before a model can be resolved against the index.
import { describe, it, expect } from "vitest";
import { parseMapModel, plannedComponents } from "../src/map/model.js";

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
      planned: false,
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

describe("parseMapModel structural rules for scoped undeclared uses", () => {
  const withPart = (component: string) => (m: Example) => {
    m.components.push({ id: "admin", name: "Admin", parent: "api", paths: ["src/api/admin/"], meaning: "Admin" });
    Object.assign(m.undeclared[0]!, { component });
  };

  it("accepts a part inside a declared requirer", () => {
    expect(issuesOf(withPart("admin"))).toEqual([]);
  });

  it.each<[string, (m: Example) => void, string]>([
    ["unknown part", withPart("nope"), "undeclared use of 'read-models' by 'api' names unknown part 'nope'"],
    [
      "the requirer itself",
      withPart("api"),
      "undeclared use of 'read-models' by 'api' names 'api', which is not a part inside 'api'",
    ],
    [
      "a part outside the requirer",
      withPart("store"),
      "undeclared use of 'read-models' by 'api' names 'store', which is not a part inside 'api'",
    ],
    [
      "a requirer that is not declared",
      (m) => {
        withPart("admin")(m);
        m.interfaces[0]!.requirers = [];
      },
      "undeclared use of 'read-models' by 'api' is scoped to 'admin', but 'api' is not a declared requirer; drop the scope",
    ],
  ])("%s", (_name, mutate, message) => {
    expect(issuesOf(mutate)).toContain(message);
  });

  it("stops at a parent cycle instead of looping", () => {
    const issues = issuesOf((m) => {
      withPart("admin")(m);
      m.components.push({ id: "loop", name: "Loop", parent: "admin", paths: ["src/loop/"], meaning: "" });
      m.components.find((c) => c.id === "admin")!.parent = "loop";
    });
    expect(issues).toContain(
      "undeclared use of 'read-models' by 'api' names 'admin', which is not a part inside 'api'",
    );
  });
});

describe("parseMapModel unknown keys", () => {
  it("reports a misspelled key", () => {
    const m = example();
    (m.components[4] as Record<string, unknown>).utlity = true;
    const { issues } = parseMapModel(m);
    expect(issues[0]!.message).toContain("utlity");
  });
});

/** The example with a planned Billing component (two parts), a planned interface it provides
 *  to the API, and its planned use of the store's read models. */
function design() {
  const m = example() as unknown as {
    components: Record<string, unknown>[];
    interfaces: Record<string, unknown>[];
    undeclared: unknown[];
  };
  m.undeclared = [];
  m.components.push(
    { id: "billing", name: "Billing", parent: "orchestrator", planned: true, meaning: "Invoices customers" },
    { id: "invoicing", name: "Invoicing", parent: "billing", meaning: "Builds invoices" },
    { id: "ledger", name: "Ledger", parent: "billing", paths: ["src/billing/ledger/"], meaning: "Keeps balances" },
    { id: "admin", name: "Admin", parent: "api", paths: ["src/api/admin/"], meaning: "Admin routes" },
  );
  m.interfaces.push({
    id: "invoices",
    name: "Invoices",
    provider: "billing",
    requirers: ["api"],
    meaning: "Invoices of a customer",
    planned: true,
    handledBy: ["invoicing"],
    usedBy: ["admin"],
  });
  Object.assign(m.interfaces[0]!, { requirers: ["api", "billing"], usedBy: ["ledger"] });
  return m;
}
type Design = ReturnType<typeof design>;
const designIssues = (mutate: (m: Design) => void = () => {}) => {
  const m = design();
  mutate(m);
  return parseMapModel(m).issues.map((i) => i.message);
};
const designIface = (m: Design, id: string) => m.interfaces.find((i) => i.id === id)!;

describe("parseMapModel planned elements", () => {
  it("accepts a planned component without paths, its parts, and a planned interface without bindings", () => {
    expect(designIssues()).toEqual([]);
  });

  it("treats the parts of a planned component as planned", () => {
    const { model } = parseMapModel(design());
    expect([...plannedComponents(model.components)].sort()).toEqual(["billing", "invoicing", "ledger"]);
  });

  it("does not follow a parent cycle when it looks for a planned ancestor", () => {
    const { model } = parseMapModel(design());
    const cyclic = model.components.map((c) => (c.id === "billing" ? { ...c, parent: "ledger", planned: false } : c));
    expect([...plannedComponents(cyclic)]).toEqual([]);
  });
});

describe("parseMapModel planned element rules", () => {
  it.each<[string, (m: Design) => void, string]>([
    [
      "an implemented component still needs paths",
      (m) => delete m.components.find((c) => c.id === "admin")!.paths,
      "component 'admin' needs paths",
    ],
    [
      "an implemented interface of a planned component",
      (m) =>
        Object.assign(designIface(m, "invoices"), { planned: false, bind: ["invoice"], handledBy: [], usedBy: [] }),
      "interface 'invoices' of planned component 'billing' must be planned",
    ],
    [
      "bind entries on a planned interface",
      (m) => (designIface(m, "invoices").bind = ["invoice"]),
      "planned interface 'invoices' cannot have bind entries or evidence; remove planned once the code exists",
    ],
    [
      "evidence on a planned interface",
      (m) => Object.assign(designIface(m, "invoices"), { kind: "http", evidence: ["src/api/hooks.ts"] }),
      "planned interface 'invoices' cannot have bind entries or evidence; remove planned once the code exists",
    ],
    [
      "handledBy on an implemented interface",
      (m) => {
        m.components.push({ id: "rows", name: "Rows", parent: "store", paths: ["src/store/rows/"], meaning: "" });
        designIface(m, "read-models").handledBy = ["rows"];
      },
      "interface 'read-models' is not planned, so it cannot declare handledBy; its delegation comes from the code",
    ],
    [
      "an unknown handledBy part",
      (m) => (designIface(m, "invoices").handledBy = ["nope"]),
      "handledBy of interface 'invoices' names unknown part 'nope'",
    ],
    [
      "a handledBy part outside the provider",
      (m) => (designIface(m, "invoices").handledBy = ["admin"]),
      "handledBy part 'admin' of interface 'invoices' is not inside its provider 'billing'",
    ],
    [
      "the provider as its own handledBy part",
      (m) => (designIface(m, "invoices").handledBy = ["billing"]),
      "handledBy part 'billing' of interface 'invoices' is not inside its provider 'billing'",
    ],
    [
      "an unknown usedBy part",
      (m) => (designIface(m, "invoices").usedBy = ["nope"]),
      "usedBy of interface 'invoices' names unknown part 'nope'",
    ],
    [
      "a usedBy part outside the requirers",
      (m) => (designIface(m, "invoices").usedBy = ["store"]),
      "usedBy part 'store' of interface 'invoices' is not inside one of its requirers",
    ],
    [
      "a usedBy part with code on an implemented interface",
      (m) => (designIface(m, "read-models").usedBy = ["admin"]),
      "usedBy part 'admin' of interface 'read-models' is not planned; its use comes from the code",
    ],
    [
      "an in-process interface of a planned external system",
      (m) => {
        m.components.push({ id: "bank", name: "Bank", parent: null, external: true, planned: true, meaning: "" });
        m.interfaces.push({ id: "pay", name: "Payments", provider: "bank", meaning: "", planned: true });
      },
      "external 'bank' can only provide cross-process interfaces ('pay')",
    ],
  ])("refuses %s", (_name, mutate, message) => {
    expect(designIssues(mutate)).toEqual([message]);
  });

  it("accepts a planned cross-process interface without evidence", () => {
    expect(designIssues((m) => (designIface(m, "invoices").kind = "http"))).toEqual([]);
  });
});
