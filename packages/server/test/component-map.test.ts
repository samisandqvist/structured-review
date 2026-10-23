import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  componentFor,
  contractKindFor,
  inferComponents,
  loadComponentMap,
  MANIFEST_FILE,
  parseManifest,
  REPOSITORY_ROOT,
  type ComponentMap,
} from "../src/component-map.js";

const manifest = (components: unknown[]) => JSON.stringify({ components });

describe("parseManifest", () => {
  it("fills defaults for optional fields", () => {
    const { components, warnings } = parseManifest(manifest([{ id: "api", paths: ["api/**"] }]));
    expect(warnings).toEqual([]);
    expect(components).toEqual([{ id: "api", paths: ["api/**"], criticality: "normal", contracts: [], consumers: [] }]);
  });

  it("keeps description, criticality, contracts and consumers", () => {
    const { components } = parseManifest(
      manifest([
        {
          id: "api",
          description: "Public HTTP API",
          paths: ["api/**"],
          criticality: "high",
          contracts: [{ kind: "http", paths: ["api/routes/**"] }],
          consumers: ["web"],
        },
        { id: "web", paths: ["web/**"] },
      ]),
    );
    expect(components[0]).toEqual({
      id: "api",
      description: "Public HTTP API",
      paths: ["api/**"],
      criticality: "high",
      contracts: [{ kind: "http", paths: ["api/routes/**"] }],
      consumers: ["web"],
    });
  });

  it("reports text that is not JSON", () => {
    const { components, warnings } = parseManifest("{ nope");
    expect(components).toEqual([]);
    expect(warnings[0]).toContain(`${MANIFEST_FILE} is not valid JSON`);
  });

  it("requires a components array", () => {
    expect(parseManifest("{}").warnings).toEqual([`${MANIFEST_FILE} needs a "components" array`]);
  });

  it("skips invalid entries and duplicate ids with a warning each", () => {
    const { components, warnings } = parseManifest(
      manifest([
        { id: "api", paths: [] },
        { id: "web", paths: ["web/**"], criticality: "urgent" },
        "not an object",
        { id: "ok", paths: ["ok/**"] },
        { id: "ok", paths: ["other/**"] },
      ]),
    );
    expect(components.map((c) => c.id)).toEqual(["ok"]);
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toMatch(/component 1 skipped: paths: /);
    expect(warnings[1]).toMatch(/component 2 skipped: criticality: /);
    expect(warnings[2]).toMatch(/component 3 skipped: /);
    expect(warnings[3]).toContain('duplicate component id "ok"');
  });

  it("drops unknown and self consumers", () => {
    const { components, warnings } = parseManifest(
      manifest([
        { id: "api", paths: ["api/**"], consumers: ["api", "ghost", "web"] },
        { id: "web", paths: ["web/**"] },
      ]),
    );
    expect(components[0]!.consumers).toEqual(["web"]);
    expect(warnings).toEqual([`${MANIFEST_FILE}: "api" lists unknown consumer "ghost"`]);
  });
});

describe("componentFor", () => {
  const manifestMap: ComponentMap = {
    source: "manifest",
    warnings: [],
    components: [
      { id: "auth", paths: ["api/auth/**"], criticality: "high", contracts: [], consumers: [] },
      {
        id: "api",
        paths: ["api/**", ".github/workflows/api.yml"],
        criticality: "normal",
        contracts: [],
        consumers: [],
      },
    ],
  };

  it("picks the first component in map order with a matching glob", () => {
    expect(componentFor("api/auth/token.ts", manifestMap)).toBe("auth");
    expect(componentFor("api/users.ts", manifestMap)).toBe("api");
    expect(componentFor(".github/workflows/api.yml", manifestMap)).toBe("api");
  });

  it("leaves unclaimed files unassigned under a manifest", () => {
    expect(componentFor("docs/readme.md", manifestMap)).toBeNull();
  });

  it("falls back to the top-level directory, or the repository root, in an inferred map", () => {
    const inferred: ComponentMap = { ...manifestMap, source: "inferred" };
    expect(componentFor("docs/guide/readme.md", inferred)).toBe("docs");
    expect(componentFor("README.md", inferred)).toBe(REPOSITORY_ROOT);
  });
});

describe("contractKindFor", () => {
  it("names the contract whose glob matches", () => {
    const spec = {
      id: "api",
      paths: ["api/**"],
      criticality: "normal" as const,
      contracts: [
        { kind: "http", paths: ["api/routes/**"] },
        { kind: "schema", paths: ["api/migrations/**"] },
      ],
      consumers: [],
    };
    expect(contractKindFor("api/migrations/001.sql", spec)).toBe("schema");
    expect(contractKindFor("api/service.ts", spec)).toBeNull();
    expect(contractKindFor("api/service.ts", undefined)).toBeNull();
  });
});

describe("loadComponentMap", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "srev-components-"));
    for (const dir of ["services/api", "services/api/packages/client", "web"])
      mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "services/api/pyproject.toml"), "");
    writeFileSync(join(root, "services/api/packages/client/package.json"), "{}");
    writeFileSync(join(root, "web/package.json"), "{}");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("infers components from project roots below the repository root, deepest first", () => {
    expect(inferComponents(root).map((c) => c.id)).toEqual(["services/api/packages/client", "services/api", "web"]);
    const map = loadComponentMap(root);
    expect(map.source).toBe("inferred");
    expect(map.warnings).toEqual([]);
    expect(componentFor("services/api/packages/client/index.ts", map)).toBe("services/api/packages/client");
  });

  it("uses a usable manifest", () => {
    writeFileSync(join(root, MANIFEST_FILE), manifest([{ id: "web", paths: ["web/**"] }]));
    const map = loadComponentMap(root);
    expect(map.source).toBe("manifest");
    expect(map.components.map((c) => c.id)).toEqual(["web"]);
  });

  it("falls back to inference, with the reasons, when the manifest has no usable component", () => {
    writeFileSync(join(root, MANIFEST_FILE), manifest([{ id: "web" }]));
    const map = loadComponentMap(root);
    expect(map.source).toBe("inferred");
    expect(map.components.length).toBe(3);
    expect(map.warnings).toHaveLength(2);
    expect(map.warnings[1]).toContain("inferred from project roots");
  });
});
