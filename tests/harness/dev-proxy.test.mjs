import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createApp } from "../../packages/server/src/app.ts";
import { createMemoryDatabase } from "../../packages/server/src/db/connection.ts";
import { StubGraphProvider } from "../../packages/server/src/graph/stub.ts";
import { createSession } from "../../packages/server/src/repo/sessions.ts";
import { getCommentsBySession } from "../../packages/server/src/repo/comments.ts";

const { serve } = createRequire(new URL("../../packages/server/package.json", import.meta.url))("@hono/node-server");
const webRequire = createRequire(new URL("../../packages/web/package.json", import.meta.url));
const { createServer, loadConfigFromFile } = await import(webRequire.resolve("vite"));

it("preserves the browser origin through the configured Vite proxy without trusting foreign origins", async () => {
  const db = createMemoryDatabase();
  const session = createSession(db, "HEAD", "main");
  const app = createApp({ db, graphProvider: new StubGraphProvider(), repoRoot: "/tmp/srev-proxy-test" });
  const backend = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  let proxy;
  try {
    await once(backend, "listening");
    const target = `http://127.0.0.1:${backend.address().port}`;
    const loaded = await loadConfigFromFile(
      { command: "serve", mode: "test" },
      fileURLToPath(new URL("../../packages/web/vite.config.ts", import.meta.url)),
    );
    const configured = loaded.config.server.proxy["/api"];
    // Keep the shipped proxy policy, replacing only the target with this test's hub.
    const options = typeof configured === "string" ? target : { ...configured, target };
    proxy = await createServer({
      configFile: false,
      root: fileURLToPath(new URL("../../packages/web", import.meta.url)),
      server: { host: "127.0.0.1", port: 0, proxy: { "/api": options } },
    });
    await proxy.listen();
    const origin = `http://127.0.0.1:${proxy.httpServer.address().port}`;
    const endpoint = `${origin}/api/sessions/${session.id}/comments`;
    const post = (browserOrigin, text) =>
      fetch(endpoint, {
        method: "POST",
        headers: { Origin: browserOrigin, "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    expect((await post(origin, "local review note")).status).toBe(200);
    expect((await post("https://untrusted.example", "unwanted note")).status).toBe(403);
    expect(getCommentsBySession(db, session.id).map((comment) => comment.text)).toEqual(["local review note"]);
  } finally {
    await proxy?.close();
    await new Promise((resolve, reject) => backend.close((error) => (error ? reject(error) : resolve())));
    db.close();
  }
}, 15_000);
