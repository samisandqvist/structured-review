import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { AppContext } from "../app.js";

type EventCallback = (data: string) => void;
const subscribers = new Map<string, Set<EventCallback>>();

export function emitEvent(sessionId: string, event: string, data: unknown): void {
  const subs = subscribers.get(sessionId);
  if (subs) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const cb of subs) cb(payload);
  }
}

export function createEventsRoute(_ctx: AppContext) {
  const router = new Hono();

  router.get("/:id/events", (c) => {
    const sessionId = c.req.param("id");
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");
    return stream(c, async (s) => {
      const cb: EventCallback = (data) => { s.write(data); };
      if (!subscribers.has(sessionId)) subscribers.set(sessionId, new Set());
      subscribers.get(sessionId)!.add(cb);
      await new Promise<void>((resolve) => {
        s.onAbort(() => {
          subscribers.get(sessionId)?.delete(cb);
          resolve();
        });
      });
    });
  });

  return router;
}
