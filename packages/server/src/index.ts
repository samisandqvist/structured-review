import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createDatabase } from "./db/connection.js";
import { StubGraphProvider } from "./graph/stub.js";
import { CrgGraphProvider } from "./graph/crg.js";

const db = createDatabase(process.env.CRW_DB_PATH || "review.db");
const useCrg = process.env.CRG_COMMAND !== undefined;
const graphProvider = useCrg
  ? new CrgGraphProvider(process.env.CRG_COMMAND!.split(" "))
  : new StubGraphProvider();

const app = createApp({ db, graphProvider });
const port = Number(process.env.PORT) || 3456;
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`review hub on http://localhost:${info.port}`);
  if (!useCrg) console.log("Using stub graph provider. Set CRG_COMMAND to use CRG.");
});
