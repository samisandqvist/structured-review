import { Hono } from "hono";
import type { DB } from "./db/connection.js";
import type { GraphProvider } from "./graph/provider.js";
import { createSessionsRoute } from "./routes/sessions.js";
import { createNodesRoute } from "./routes/nodes.js";
import { createCommentsRoute } from "./routes/comments.js";
import { createEventsRoute } from "./routes/events.js";
import { createFlowsRoute } from "./routes/flows.js";
import { createChangesRoute } from "./routes/changes.js";

export interface AppContext {
  db: DB;
  graphProvider: GraphProvider;
}

export function createApp(ctx: AppContext) {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/api/sessions", createSessionsRoute(ctx));
  app.route("/api/sessions", createNodesRoute(ctx));
  app.route("/api/sessions", createCommentsRoute(ctx));
  app.route("/api/sessions", createEventsRoute(ctx));
  app.route("/api/sessions", createFlowsRoute(ctx));
  app.route("/api/sessions", createChangesRoute(ctx));
  return app;
}
