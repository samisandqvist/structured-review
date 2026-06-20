import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

export function createStaticRoute(webDistPath: string) {
  const router = new Hono();
  router.use("/*", serveStatic({ root: webDistPath }));
  return router;
}
