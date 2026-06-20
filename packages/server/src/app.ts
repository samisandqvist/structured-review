import { Hono } from "hono";
import type { DB } from "./db/connection.js";
import type { GraphProvider } from "./graph/provider.js";
import { createSessionsRoute } from "./routes/sessions.js";
import { createNodesRoute } from "./routes/nodes.js";

export interface AppContext {
  db: DB;
  graphProvider: GraphProvider;
}

export function createApp(ctx: AppContext) {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/api/sessions", createSessionsRoute(ctx));
  app.route("/api/sessions", createNodesRoute(ctx));
  return app;
}
