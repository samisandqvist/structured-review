import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { DB } from "./db/connection.js";
import type { GraphProvider } from "./graph/provider.js";
import { repoRoot as defaultRepoRoot } from "./diff.js";
import { createStaticRoute } from "./static.js";
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
  /** Built web SPA dir. When set and it contains index.html, the app serves it after the API. */
  webDistPath?: string;
  /** Graph provider name reported on /health (scip | crg | stub). */
  providerName?: string;
  /** Called after POST /api/shutdown responds. index.ts exits the process;
   *  tests leave it unset and the endpoint reports shutdown unsupported. */
  onShutdown?: () => void;
}

export function createApp(ctx: AppContext) {
  const resolved: AppContext = { ...ctx, repoRoot: ctx.repoRoot ?? defaultRepoRoot() };
  const app = new Hono();
  // repoRoot + pid let a CLI tell "the right hub for this repo" apart from a
  // stranger squatting on the port (crw serve reuse-or-error decision).
  app.get("/health", (c) =>
    c.json({ ok: true, repoRoot: resolved.repoRoot, pid: process.pid, provider: resolved.providerName ?? "unknown" })
  );
  // Sanctioned stop for `crw gc`: the hub must be down before its DB files are
  // removed (WAL). The handler fires after the response is written.
  app.post("/api/shutdown", (c) => {
    if (!resolved.onShutdown) return c.json({ ok: false, error: "shutdown not supported" }, 501);
    const onShutdown = resolved.onShutdown;
    setTimeout(onShutdown, 150);
    return c.json({ ok: true, pid: process.pid });
  });
  app.route("/api/sessions", createSessionsRoute(resolved));
  app.route("/api/sessions", createNodesRoute(resolved));
  app.route("/api/sessions", createCommentsRoute(resolved));
  app.route("/api/sessions", createEventsRoute(resolved));
  app.route("/api/sessions", createFlowsRoute(resolved));
  app.route("/api/sessions", createChangesRoute(resolved));
  // Static SPA is mounted LAST so its /* catch-all never shadows /health or /api/*.
  if (resolved.webDistPath && existsSync(join(resolved.webDistPath, "index.html"))) {
    app.route("/", createStaticRoute(resolved.webDistPath));
  }
  return app;
}
