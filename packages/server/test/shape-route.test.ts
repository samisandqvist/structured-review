import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DB } from "../src/db/connection.js";
import { createMemoryDatabase } from "../src/db/connection.js";
import { createApp } from "../src/app.js";
import { StubGraphProvider } from "../src/graph/stub.js";
import { directoryExistsAt, parseNameStatus } from "../src/diff.js";

let db: DB;
let root: string;
let app: ReturnType<typeof createApp>;
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

beforeEach(() => {
  db = createMemoryDatabase();
  root = mkdtempSync(join(tmpdir(), "srev-shape-"));
  git("init", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  write("api/routes/users.ts", "export const users = 1;\n");
  write("api/old-name.ts", "export const moved = 1;\n".repeat(5));
  write("web/app.ts", "export const app = 1;\n");
  git("add", ".");
  git("commit", "-m", "init");
  app = createApp({ db, graphProvider: new StubGraphProvider(), repoRoot: root });
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function sessionId(baseRef = "main"): Promise<string> {
  const res = await app.request("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branch: "HEAD", baseRef }),
  });
  return (await res.json()).session.id;
}

describe("GET /api/sessions/:id/shape", () => {
  it("returns the shape of the working tree against the session base, using the manifest", async () => {
    write(
      ".review-components.json",
      JSON.stringify({
        components: [
          {
            id: "api",
            paths: ["api/**"],
            criticality: "high",
            contracts: [{ kind: "http", paths: ["api/routes/**"] }],
            consumers: ["web"],
          },
          { id: "web", paths: ["web/**"] },
        ],
      }),
    );
    write("api/routes/users.ts", "export const users = 2;\n");
    write("api/engine/run.ts", "export const run = 1;\n");
    git("mv", "api/old-name.ts", "api/new-name.ts");
    git("add", "api/engine/run.ts");
    const id = await sessionId();

    const res = await app.request(`/api/sessions/${id}/shape`);
    expect(res.status).toBe(200);
    const shape = await res.json();
    expect(shape.source).toBe("manifest");
    const api = shape.components[0];
    expect(api.id).toBe("api");
    expect(api.files).toEqual(
      expect.arrayContaining([
        { path: "api/routes/users.ts", status: "modified", contract: "http" },
        { path: "api/engine/run.ts", status: "added" },
        { path: "api/new-name.ts", status: "renamed", oldPath: "api/old-name.ts" },
      ]),
    );
    expect(api.newDirectories).toEqual(["api/engine"]);
    expect(shape.outsideConsumers).toEqual([
      { id: "web", criticality: "normal", via: [{ component: "api", contracts: ["http"] }] },
    ]);
    // The untracked manifest is not part of the change.
    expect(shape.unassigned).toEqual([]);
  });

  it("infers components when the repository has no manifest", async () => {
    write("web/app.ts", "export const app = 2;\n");
    const id = await sessionId();
    const shape = await (await app.request(`/api/sessions/${id}/shape`)).json();
    expect(shape.source).toBe("inferred");
    expect(shape.components.map((c: { id: string }) => c.id)).toEqual(["web"]);
  });

  it("answers 404 for an unknown session", async () => {
    expect((await app.request("/api/sessions/nope/shape")).status).toBe(404);
  });

  it("reports a git failure when the base no longer resolves", async () => {
    git("checkout", "-q", "-b", "feature");
    git("tag", "gone");
    const id = await sessionId("gone");
    git("tag", "-d", "gone");
    const res = await app.request(`/api/sessions/${id}/shape`);
    expect(res.status).toBe(500);
    expect((await res.json()).phase).toBe("list-files");
  });
});

describe("git helpers for the change shape", () => {
  it("parses name-status output, including renames and copies", () => {
    expect(parseNameStatus("M\0a.ts\0R087\0old.ts\0new.ts\0C100\0src.ts\0copy.ts\0D\0gone.ts\0T\0link\0")).toEqual([
      { path: "a.ts", status: "modified" },
      { path: "new.ts", status: "renamed", oldPath: "old.ts" },
      { path: "copy.ts", status: "added" },
      { path: "gone.ts", status: "deleted" },
      { path: "link", status: "modified" },
    ]);
    expect(parseNameStatus("")).toEqual([]);
  });

  it("tells directories in a ref's tree from files and missing paths", () => {
    expect(directoryExistsAt("main", "", root)).toBe(true);
    expect(directoryExistsAt("main", "api/routes", root)).toBe(true);
    expect(directoryExistsAt("main", "api/routes/users.ts", root)).toBe(false);
    expect(directoryExistsAt("main", "api/engine", root)).toBe(false);
  });
});
