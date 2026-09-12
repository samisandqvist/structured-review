import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createMemoryDatabase, type DB } from "../src/db/connection.js";
import { StubGraphProvider } from "../src/graph/stub.js";
import { createSession } from "../src/repo/sessions.js";
import { getCommentsBySession } from "../src/repo/comments.js";

let db: DB;
let app: ReturnType<typeof createApp>;
let sessionId: string;
let stopped: boolean;
const hub = "http://127.0.0.1:3456";

beforeEach(() => {
  vi.useFakeTimers();
  db = createMemoryDatabase();
  sessionId = createSession(db, "HEAD", "main").id;
  stopped = false;
  app = createApp({
    db,
    graphProvider: new StubGraphProvider(),
    repoRoot: "/tmp/crw-request-security",
    onShutdown: () => {
      stopped = true;
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe("local request boundary", () => {
  it.each([
    "https://untrusted.example",
    "null",
    "http://localhost:3456",
    "http://127.0.0.1:9999",
    "https://127.0.0.1:3456",
    "http://127.0.0.1:3456.untrusted.example",
  ])("rejects shutdown from Origin %s without scheduling an exit", async (origin) => {
    const res = await app.request(`${hub}/api/shutdown`, { method: "POST", headers: { Origin: origin } });
    await vi.runAllTimersAsync();
    expect(stopped).toBe(false);
    expect(res.status).toBe(403);
  });

  it.each(["GET", "POST"])("rejects cross-site %s even without Origin", async (method) => {
    const path = method === "GET" ? "/health" : "/api/shutdown";
    const res = await app.request(`${hub}${path}`, { method, headers: { "Sec-Fetch-Site": "cross-site" } });
    await vi.runAllTimersAsync();
    expect(stopped).toBe(false);
    expect(res.status).toBe(403);
  });

  it.each(["untrusted.example:3456", "localhost.untrusted.example", "127.0.0.1.untrusted.example", "192.168.1.2:3456"])(
    "rejects non-loopback request authority %s",
    async (authority) => {
      const res = await app.request(`http://${authority}/health`);
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("repoRoot");
    },
  );

  it("rejects an untrusted Host header even when the request URL is loopback", async () => {
    const res = await app.request(`${hub}/health`, { headers: { Host: "untrusted.example:3456" } });
    expect(res.status).toBe(403);
  });

  it("rejects foreign-origin reads without exposing health data", async () => {
    const res = await app.request(`${hub}/health`, { headers: { Origin: "https://untrusted.example" } });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("repoRoot");
  });

  it("rejects foreign-origin JSON writes without persisting a comment", async () => {
    const res = await app.request(`${hub}/api/sessions/${sessionId}/comments`, {
      method: "POST",
      headers: { Origin: "https://untrusted.example", "Content-Type": "application/json" },
      body: JSON.stringify({ text: "unwanted comment" }),
    });
    expect(getCommentsBySession(db, sessionId)).toEqual([]);
    expect(res.status).toBe(403);
  });
});

describe("supported local clients and JSON writes", () => {
  it.each(["http://localhost:5173", hub, "http://[::1]:3456"])(
    "allows same-origin JSON writes at %s, including the Vite proxy",
    async (origin) => {
      const res = await app.request(`${origin}/api/sessions/${sessionId}/comments`, {
        method: "POST",
        headers: {
          Origin: origin,
          Host: new URL(origin).host,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ text: "review note" }),
      });
      expect(res.status).toBe(200);
      expect(getCommentsBySession(db, sessionId).map((comment) => comment.text)).toEqual(["review note"]);
    },
  );

  it("allows bodyless CLI shutdown without browser headers", async () => {
    const res = await app.request(`${hub}/api/shutdown`, { method: "POST" });
    await vi.runAllTimersAsync();
    expect(res.status).toBe(200);
    expect(stopped).toBe(true);
  });

  it.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/jsonp", ""])(
    "rejects JSON writes with content type %j",
    async (contentType) => {
      const headers = contentType ? { "Content-Type": contentType } : {};
      const res = await app.request(`${hub}/api/sessions/${sessionId}/comments`, {
        method: "POST",
        headers,
        body: new TextEncoder().encode(JSON.stringify({ text: "unwanted comment" })),
      });
      expect(getCommentsBySession(db, sessionId)).toEqual([]);
      expect(res.status).toBe(415);
    },
  );
});
