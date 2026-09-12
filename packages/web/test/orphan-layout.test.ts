import { describe, it, expect } from "vitest";
import { buildOrphanLayout, orphanWalkIds } from "../src/orphan-layout.js";
import type { Node } from "../src/api/client.js";

function node(stableId: string, file: string, residualKind: Node["residualKind"] = null): Node {
  return {
    id: `id-${stableId}`,
    sessionId: "s1",
    stableId,
    label: stableId,
    file,
    startLine: 1,
    endLine: 10,
    changeStatus: "changed",
    reviewStatus: "unreviewed",
    reviewedInUnit: null,
    isTest: false,
    residualKind,
  };
}

const byStable = (nodes: Node[]) => new Map(nodes.map((n) => [n.stableId, n]));

describe("buildOrphanLayout", () => {
  it("renders flat (dir null, no nesting) for a single-directory unit of functions", () => {
    const nodes = [node("fn:a", "src/a.ts"), node("fn:b", "src/b.ts")];
    const layout = buildOrphanLayout(["fn:a", "fn:b"], byStable(nodes));
    expect(layout).toHaveLength(1);
    expect(layout[0].dir).toBeNull();
    expect(layout[0].entries.map((e) => e.node.stableId)).toEqual(["fn:a", "fn:b"]);
  });

  it("groups members by directory in order of first appearance", () => {
    const nodes = [
      node("res:m1", "drizzle/meta/0000.json", "whole-file"),
      node("res:d1", "drizzle/0001.sql", "whole-file"),
      node("fn:svc", "src/database/database.service.ts"),
      node("res:d2", "drizzle/0002.sql", "whole-file"),
    ];
    const layout = buildOrphanLayout(["res:m1", "res:d1", "fn:svc", "res:d2"], byStable(nodes));
    expect(layout.map((g) => g.dir)).toEqual(["drizzle/meta", "drizzle", "src/database"]);
    expect(layout[1].entries.map((e) => e.node.stableId)).toEqual(["res:d1", "res:d2"]);
  });

  it("nests a file residual under its file's function node, even listed first", () => {
    const nodes = [
      node("file-residual:src/admin/admin.guard.ts", "src/admin/admin.guard.ts", "module-scope"),
      node("fn:canActivate", "src/admin/admin.guard.ts"),
    ];
    const layout = buildOrphanLayout(["file-residual:src/admin/admin.guard.ts", "fn:canActivate"], byStable(nodes));
    expect(layout[0].entries).toHaveLength(1);
    expect(layout[0].entries[0].node.stableId).toBe("fn:canActivate");
    expect(layout[0].entries[0].nested.map((n) => n.stableId)).toEqual(["file-residual:src/admin/admin.guard.ts"]);
  });

  it("keeps a residual top-level when no function node shares its file", () => {
    const nodes = [node("res:x", "conf/x.yml", "whole-file"), node("fn:a", "src/a.ts")];
    const layout = buildOrphanLayout(["res:x", "fn:a"], byStable(nodes));
    const all = layout.flatMap((g) => g.entries.map((e) => e.node.stableId));
    expect(all).toContain("res:x");
  });

  it("uses '.' for repo-root files when directories are mixed", () => {
    const nodes = [node("res:root", "README.md", "whole-file"), node("fn:a", "src/a.ts")];
    const layout = buildOrphanLayout(["res:root", "fn:a"], byStable(nodes));
    expect(layout.map((g) => g.dir)).toEqual([".", "src"]);
  });
});

describe("orphanWalkIds", () => {
  it("walks residuals right after their parent, directory groups in order", () => {
    const nodes = [
      node("file-residual:src/a.ts", "src/a.ts", "module-scope"),
      node("fn:a", "src/a.ts"),
      node("res:cfg", "conf/x.yml", "whole-file"),
    ];
    expect(orphanWalkIds(["file-residual:src/a.ts", "fn:a", "res:cfg"], byStable(nodes))).toEqual([
      "fn:a",
      "file-residual:src/a.ts",
      "res:cfg",
    ]);
  });

  it("never drops members that lack a session node", () => {
    expect(orphanWalkIds(["fn:ghost"], new Map())).toEqual(["fn:ghost"]);
  });
});
