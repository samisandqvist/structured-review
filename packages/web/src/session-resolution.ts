import type { ReviewSession } from "./api/client.js";

export type SessionResolution =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "picker"; sessions: ReviewSession[] }
  | { kind: "session"; sessionId: string };

/** Decide what the main page shows: an explicit ?session param always wins;
 *  otherwise a lone session loads directly and several open the picker. */
export function resolveSession(
  paramId: string | null,
  sessions: ReviewSession[] | undefined
): SessionResolution {
  if (paramId) return { kind: "session", sessionId: paramId };
  if (!sessions) return { kind: "loading" };
  if (sessions.length === 0) return { kind: "empty" };
  if (sessions.length === 1) return { kind: "session", sessionId: sessions[0].id };
  return { kind: "picker", sessions };
}
