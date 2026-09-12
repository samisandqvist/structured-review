import { createMiddleware } from "hono/factory";

const loopbackAuthority = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

/** The hub trusts local CLI clients, but must not accept requests from foreign
 * browser origins or DNS names that can be rebound to a loopback address.
 * Vite preserves the original Host when proxying, so its UI remains same-origin. */
export const localRequestsOnly = createMiddleware(async (c, next) => {
  const url = new URL(c.req.url);
  const host = c.req.header("Host") ?? url.host;
  if (!loopbackAuthority.test(url.host) || !loopbackAuthority.test(host)) {
    return c.json({ error: "loopback host required" }, 403);
  }
  const origin = c.req.header("Origin");
  if (origin !== undefined && origin !== url.origin) {
    return c.json({ error: "same-origin request required" }, 403);
  }
  if (c.req.header("Sec-Fetch-Site") === "cross-site") {
    return c.json({ error: "cross-site request rejected" }, 403);
  }
  await next();
});
