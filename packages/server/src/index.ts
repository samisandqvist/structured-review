import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createDatabase } from "./db/connection.js";
import type { GraphProvider } from "./graph/provider.js";
import { StubGraphProvider } from "./graph/stub.js";
import { CrgGraphProvider } from "./graph/crg.js";
import { ScipGraphProvider } from "./graph/scip.js";

const db = createDatabase(process.env.CRW_DB_PATH || "review.db");

// GRAPH_PROVIDER selects the graph source; SCIP (scip-typescript) is the
// default. Set GRAPH_PROVIDER=crg or =stub to override.
const which = (process.env.GRAPH_PROVIDER || "scip").toLowerCase();
let graphProvider: GraphProvider;
switch (which) {
  case "scip":
    graphProvider = new ScipGraphProvider();
    break;
  case "crg":
    graphProvider = new CrgGraphProvider((process.env.CRG_COMMAND ?? "code-review-graph serve").split(" "));
    break;
  default:
    graphProvider = new StubGraphProvider();
}

const here = dirname(fileURLToPath(import.meta.url));
// Candidates: env override; monorepo layout (dist/index.js -> ../../web/dist,
// same from src in dev); plugin bundle layout (plugin/dist/server.js -> ../web).
const webDistPath = [process.env.CRW_WEB_DIST, join(here, "..", "..", "web", "dist"), join(here, "..", "web")].find(
  (p) => p && existsSync(join(p, "index.html")),
);
const webBuilt = webDistPath !== undefined;

const hostname = process.env.CRW_HOST || "127.0.0.1";
if (hostname !== "127.0.0.1" && hostname !== "localhost") {
  console.warn(
    `WARNING: binding to ${hostname} — the review API is unauthenticated; keep it loopback-only unless you know why`,
  );
}

const app = createApp({
  db,
  graphProvider,
  ...(webBuilt ? { webDistPath } : {}),
  providerName: which,
  onShutdown: () => process.exit(0),
});
const port = Number(process.env.PORT) || 3456;
serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(
    `review hub on http://localhost:${info.port} (graph provider: ${which}${webBuilt ? "" : "; web UI not built — run pnpm build"})`,
  );
});
