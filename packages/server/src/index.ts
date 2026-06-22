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

const app = createApp({ db, graphProvider });
const port = Number(process.env.PORT) || 3456;
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`review hub on http://localhost:${info.port} (graph provider: ${which})`);
});
