import { afterEach, expect, it, vi } from "vitest";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerType } from "@hono/node-server";
import type { DB } from "../src/db/connection.js";

const resources = vi.hoisted(() => ({ server: undefined as ServerType | undefined, db: undefined as DB | undefined }));
vi.mock("@hono/node-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hono/node-server")>();
  return {
    ...actual,
    serve: (...args: Parameters<typeof actual.serve>) => {
      resources.server = actual.serve({ ...args[0], port: 0 }, args[1]);
      return resources.server;
    },
  };
});
vi.mock("../src/db/connection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/connection.js")>();
  return {
    ...actual,
    createDatabase: (path: string) => {
      resources.db = actual.createDatabase(path);
      return resources.db;
    },
  };
});
let directory: string;
afterEach(async () => {
  if (resources.server) {
    await new Promise<void>((resolve, reject) =>
      resources.server!.close((error) => (error ? reject(error) : resolve())),
    );
  }
  resources.db?.close();
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("honors the renamed database, web-root and host settings on real server startup", async () => {
  directory = mkdtempSync(join(tmpdir(), "srev-startup-"));
  writeFileSync(join(directory, "index.html"), "<h1>Custom Structured Review web root</h1>");
  const database = join(directory, "custom.db");
  vi.stubEnv("SREV_DB_PATH", database);
  vi.stubEnv("SREV_WEB_DIST", directory);
  vi.stubEnv("SREV_HOST", "127.0.0.1");
  vi.stubEnv("GRAPH_PROVIDER", "stub");
  await import("../src/index.js");
  const server = resources.server!;
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing TCP listener");
  expect(address.address).toBe("127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  expect(await fetch(`${base}/`).then((res) => res.text())).toContain("Custom Structured Review web root");
  expect(await fetch(`${base}/health`).then((res) => res.json())).toMatchObject({ ok: true, provider: "stub" });
  expect(existsSync(database)).toBe(true);
});
