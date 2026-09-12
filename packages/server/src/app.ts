import type { AppContext } from "./context.js";
export type { AppContext } from "./context.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { repoRoot as defaultRepoRoot } from "./diff.js";
import { createStaticRoute } from "./static.js";
import { createSessionsRoute } from "./routes/sessions.js";
import { createNodesRoute } from "./routes/nodes.js";
import { createCommentsRoute } from "./routes/comments.js";
import { createEventsRoute } from "./routes/events.js";
import { createFlowsRoute } from "./routes/flows.js";
import { createChangesRoute } from "./routes/changes.js";
import { localRequestsOnly } from "./request-security.js";

export function createApp(ctx: AppContext) {
  const resolved: AppContext = { ...ctx, repoRoot: ctx.repoRoot ?? defaultRepoRoot() };
  const app = new Hono();
  app.use("*", localRequestsOnly);
  // repoRoot + pid let a CLI tell "the right hub for this repo" apart from a
  // stranger squatting on the port (srev serve reuse-or-error decision).
  app.get("/health", (c) =>
    c.json({ ok: true, repoRoot: resolved.repoRoot, pid: process.pid, provider: resolved.providerName ?? "unknown" }),
  );
  // Sanctioned stop for `srev gc`: the hub must be down before its DB files are
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
