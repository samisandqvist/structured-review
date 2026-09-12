import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DB } from "../src/db/connection.js";
import { createMemoryDatabase } from "../src/db/connection.js";
import { createApp } from "../src/app.js";
import { StubGraphProvider } from "../src/graph/stub.js";

let db: DB;
let dist: string;
let repoRoot: string;

beforeEach(() => {
  db = createMemoryDatabase();
  dist = mkdtempSync(join(tmpdir(), "srev-dist-"));
  repoRoot = mkdtempSync(join(tmpdir(), "srev-static-repo-"));
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><div id=root></div>");
  writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
});
afterEach(() => {
  db.close();
  rmSync(dist, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

function withDist() {
  return createApp({ db, graphProvider: new StubGraphProvider(), repoRoot, webDistPath: dist });
}

describe("static SPA route", () => {
  it("serves index.html at /", async () => {
    const res = await withDist().request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("id=root");
  });

  it("serves static assets with correct content type", async () => {
    const res = await withDist().request("/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toContain("console.log(1)");
  });

  it("falls back to index.html for SPA routes (e.g. deep links)", async () => {
    const res = await withDist().request("/some/client/route");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("id=root");
  });

  it("does not shadow the /health route", async () => {
    const res = await withDist().request("/health");
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("does not shadow API routes (unknown session → 404 JSON, not index.html)", async () => {
    const res = await withDist().request("/api/sessions/nope");
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain("id=root");
  });

  it("returns a JSON 404 for unregistered /api/* paths instead of index.html", async () => {
    const res = await withDist().request("/api/definitely-not-registered");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("rejects path traversal", async () => {
    const res = await withDist().request("/..%2f..%2f..%2fetc%2fpasswd");
    // must not leak files outside dist: either 404 or index.html fallback,
    // never the traversed file's content.
    expect(res.status).not.toBe(500);
    expect(await res.text()).not.toContain("root:");
  });

  it("app without webDistPath keeps current behavior (/ → 404)", async () => {
    const app = createApp({ db, graphProvider: new StubGraphProvider(), repoRoot });
    const res = await app.request("/");
    expect(res.status).toBe(404);
  });
});
