import { Hono } from "hono";
import type { DB } from "./db/connection.js";
import type { GraphProvider } from "./graph/provider.js";
import { repoRoot as defaultRepoRoot } from "./diff.js";
import { createSessionsRoute } from "./routes/sessions.js";
import { createNodesRoute } from "./routes/nodes.js";
import { createCommentsRoute } from "./routes/comments.js";
import { createEventsRoute } from "./routes/events.js";
import { createFlowsRoute } from "./routes/flows.js";
import { createChangesRoute } from "./routes/changes.js";

export interface AppContext {
  db: DB;
  graphProvider: GraphProvider;
  /** Git root the hub reads diffs from. Defaults to the ambient repo; tests pin a fixture. */
  repoRoot?: string;
}

export function createApp(ctx: AppContext) {
  const resolved: AppContext = { ...ctx, repoRoot: ctx.repoRoot ?? defaultRepoRoot() };
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/api/sessions", createSessionsRoute(resolved));
  app.route("/api/sessions", createNodesRoute(resolved));
  app.route("/api/sessions", createCommentsRoute(resolved));
  app.route("/api/sessions", createEventsRoute(resolved));
  app.route("/api/sessions", createFlowsRoute(resolved));
  app.route("/api/sessions", createChangesRoute(resolved));
  return app;
}
