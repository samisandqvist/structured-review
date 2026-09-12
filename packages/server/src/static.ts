import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { Hono } from "hono";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

/** Serves a built SPA: real files from dist, index.html for everything else. */
export function createStaticRoute(webDistPath: string) {
  const router = new Hono();
  const indexHtml = () => readFileSync(join(webDistPath, "index.html"), "utf8");
  router.get("/*", (c) => {
    const rel = normalize(decodeURIComponent(new URL(c.req.url).pathname)).replace(/^([/\\]|\.\.)+/, "");
    const file = join(webDistPath, rel);
    if (rel && file.startsWith(webDistPath) && existsSync(file) && statSync(file).isFile()) {
      return c.body(new Uint8Array(readFileSync(file)), 200, {
        "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      });
    }
    if (rel === "api" || rel.startsWith("api/") || rel.startsWith("api\\")) {
      return c.json({ error: "not found" }, 404);
    }
    return c.html(indexHtml());
  });
  return router;
}
