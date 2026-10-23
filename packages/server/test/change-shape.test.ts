import { describe, it, expect } from "vitest";
import { buildChangeShape } from "../src/change-shape.js";
import type { ComponentMap } from "../src/component-map.js";
import type { FileChange } from "../src/diff.js";

const map: ComponentMap = {
  source: "manifest",
  warnings: ["a warning"],
  components: [
    {
      id: "api",
      description: "HTTP API",
      paths: ["api/**"],
      criticality: "high",
      contracts: [
        { kind: "http", paths: ["api/routes/**"] },
        { kind: "schema", paths: ["api/migrations/**"] },
      ],
      consumers: ["web", "worker"],
    },
    { id: "web", paths: ["web/**"], criticality: "normal", contracts: [], consumers: [] },
    {
      id: "worker",
      description: "Queue worker",
      paths: ["worker/**"],
      criticality: "low",
      contracts: [{ kind: "queue", paths: ["worker/messages/**"] }],
      consumers: ["web"],
    },
    { id: "docs", paths: ["docs/**"], criticality: "low", contracts: [], consumers: [] },
  ],
};

const existing = new Set(["api", "api/routes", "web", "worker", "docs"]);
const existedAtBase = (dir: string) => existing.has(dir);

describe("buildChangeShape", () => {
  it("groups files by component and orders components by criticality, then size", () => {
    const changes: FileChange[] = [
      { path: "docs/a.md", status: "modified" },
      { path: "docs/b.md", status: "modified" },
      { path: "web/app.ts", status: "modified" },
      { path: "api/service.ts", status: "modified" },
    ];
    const shape = buildChangeShape(changes, map, existedAtBase);
    expect(shape.source).toBe("manifest");
    expect(shape.warnings).toEqual(["a warning"]);
    expect(shape.components.map((c) => c.id)).toEqual(["api", "web", "docs"]);
    expect(shape.components[0]).toMatchObject({ description: "HTTP API", criticality: "high" });
    expect(shape.components[1]).not.toHaveProperty("description");
  });

  it("marks contract files and lists consumers only when a contract changed", () => {
    const shape = buildChangeShape(
      [
        { path: "api/routes/users.ts", status: "modified" },
        { path: "api/migrations/002.sql", status: "added" },
        { path: "web/app.ts", status: "modified" },
      ],
      map,
      existedAtBase,
    );
    const api = shape.components.find((c) => c.id === "api")!;
    expect(api.files.map((f) => f.contract)).toEqual(["http", "schema"]);
    expect(api.changedContracts).toEqual(["http", "schema"]);
    expect(api.consumers).toEqual([
      { id: "web", inChange: true },
      { id: "worker", inChange: false },
    ]);

    const quiet = buildChangeShape([{ path: "api/service.ts", status: "modified" }], map, existedAtBase);
    expect(quiet.components[0]!.consumers).toEqual([]);
    expect(quiet.outsideConsumers).toEqual([]);
  });

  it("collects consumers outside the change across changed components", () => {
    const shape = buildChangeShape(
      [
        { path: "api/routes/users.ts", status: "modified" },
        { path: "worker/messages/job.ts", status: "modified" },
      ],
      map,
      existedAtBase,
    );
    expect(shape.outsideConsumers).toEqual([
      {
        id: "web",
        criticality: "normal",
        via: [
          { component: "api", contracts: ["http"] },
          { component: "worker", contracts: ["queue"] },
        ],
      },
    ]);
    // worker is in the change itself, so it is not outside.
    expect(shape.outsideConsumers.map((c) => c.id)).not.toContain("worker");
  });

  it("describes an outside consumer that has a description", () => {
    const shape = buildChangeShape([{ path: "api/routes/users.ts", status: "modified" }], map, existedAtBase);
    expect(shape.outsideConsumers.map((c) => c.id)).toEqual(["web", "worker"]);
    expect(shape.outsideConsumers[1]).toMatchObject({ description: "Queue worker", criticality: "low" });
  });
});

describe("buildChangeShape: new directories and unclaimed files", () => {
  it("reports the topmost new directory of added and renamed files", () => {
    const shape = buildChangeShape(
      [
        { path: "api/engine/core/run.ts", status: "added" },
        { path: "api/engine/core/plan.ts", status: "added" },
        { path: "api/routes/new.ts", status: "added" },
        { path: "web/pages/x.tsx", status: "renamed", oldPath: "web/x.tsx" },
        { path: "docs/gone/old.md", status: "deleted" },
      ],
      map,
      existedAtBase,
    );
    expect(shape.components.find((c) => c.id === "api")!.newDirectories).toEqual(["api/engine"]);
    expect(shape.components.find((c) => c.id === "web")!.newDirectories).toEqual(["web/pages"]);
    expect(shape.components.find((c) => c.id === "docs")!.newDirectories).toEqual([]);
  });

  it("puts files no manifest component claims in unassigned", () => {
    const shape = buildChangeShape([{ path: "scripts/run.sh", status: "added" }], map, () => true);
    expect(shape.components).toEqual([]);
    expect(shape.unassigned).toEqual([{ path: "scripts/run.sh", status: "added" }]);
  });

  it("groups by top-level directory in an inferred map", () => {
    const inferred: ComponentMap = { source: "inferred", warnings: [], components: [] };
    const shape = buildChangeShape(
      [
        { path: "lib/a.ts", status: "modified" },
        { path: "README.md", status: "modified" },
      ],
      inferred,
      () => true,
    );
    expect(shape.components.map((c) => [c.id, c.criticality])).toEqual([
      ["(repository root)", "normal"],
      ["lib", "normal"],
    ]);
    expect(shape.unassigned).toEqual([]);
  });
});
