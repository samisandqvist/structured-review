import { serve } from "@hono/node-server";
import { Hono } from "hono";

const app = new Hono();
app.get("/health", (c) => c.json({ ok: true }));

serve({ fetch: app.fetch, port: 3456 }, (info) => {
  console.log(`review hub on http://localhost:${info.port}`);
});
