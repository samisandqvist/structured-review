// Session routes answer 404 for an unknown session before reading the body.
import { describe, it, expect } from "vitest";
import { createMemoryDatabase } from "../src/db/connection.js";
import { createApp } from "../src/app.js";
import { StubGraphProvider } from "../src/graph/stub.js";

const app = createApp({ db: createMemoryDatabase(), graphProvider: new StubGraphProvider(), repoRoot: process.cwd() });
const send = (path: string, method: string) =>
  app.request(path, { method, headers: { "Content-Type": "application/json" }, body: "{}" });

describe("session routes for an unknown session", () => {
  it("answers 404 for the plan and unit updates", async () => {
    expect((await send("/api/sessions/nope/plan", "PUT")).status).toBe(404);
    expect((await send("/api/sessions/nope/units/u1", "PATCH")).status).toBe(404);
  });
});
