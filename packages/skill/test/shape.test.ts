import { describe, it, expect } from "vitest";
import { prettyShape, type ChangeShape } from "../src/shape.js";

describe("prettyShape", () => {
  it("lists components with contracts, new directories, consumers and warnings", () => {
    const shape: ChangeShape = {
      source: "manifest",
      warnings: ["bad entry"],
      components: [
        {
          id: "api",
          description: "HTTP API",
          criticality: "high",
          files: [
            { path: "api/routes/a.ts", status: "modified", contract: "http" },
            { path: "api/engine/b.ts", status: "added" },
            { path: "api/engine/c.ts", status: "added" },
          ],
          newDirectories: ["api/engine"],
          changedContracts: ["http"],
          consumers: [
            { id: "web", inChange: true },
            { id: "worker", inChange: false },
          ],
        },
        {
          id: "web",
          criticality: "normal",
          files: [{ path: "web/x.ts", status: "modified" }],
          newDirectories: [],
          changedContracts: [],
          consumers: [],
        },
      ],
      unassigned: [{ path: "tools/run.sh", status: "added" }],
      outsideConsumers: [
        { id: "worker", criticality: "low", via: [{ component: "api", contracts: ["http", "schema"] }] },
      ],
    };
    expect(prettyShape(shape)).toBe(
      [
        "Components (from the component manifest):",
        "  api [high] HTTP API: 3 files (1 modified, 2 added)",
        "    contracts changed: http",
        "    new directories: api/engine",
        "    consumers: web (in the change), worker (outside the change)",
        "  web [normal]: 1 file (1 modified)",
        "Consumers outside the change:",
        "  worker [low]: uses http/schema of api",
        "Unassigned: tools/run.sh",
        "⚠ bad entry",
      ].join("\n"),
    );
  });

  it("names an inferred map and omits empty sections", () => {
    const shape: ChangeShape = {
      source: "inferred",
      warnings: [],
      components: [],
      unassigned: [],
      outsideConsumers: [],
    };
    expect(prettyShape(shape)).toBe("Components (inferred):");
  });
});
