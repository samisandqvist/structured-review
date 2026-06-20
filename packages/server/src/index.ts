import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createDatabase } from "./db/connection.js";
import { StubGraphProvider } from "./graph/stub.js";

const db = createDatabase(process.env.CRW_DB_PATH || "review.db");
const app = createApp({ db, graphProvider: new StubGraphProvider() });

const port = Number(process.env.PORT) || 3456;
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`review hub on http://localhost:${info.port}`);
});
