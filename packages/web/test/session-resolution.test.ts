import { describe, it, expect } from "vitest";
import { resolveSession } from "../src/session-resolution.js";
import type { ReviewSession } from "../src/api/client.js";

function session(id: string): ReviewSession {
  return { id, branch: `branch-${id}`, baseRef: "main", status: "walking", createdAt: 1755000000000 };
}

describe("resolveSession", () => {
  it("loads the session named by the URL param without waiting for the list", () => {
    expect(resolveSession("ses_abc", undefined)).toEqual({ kind: "session", sessionId: "ses_abc" });
  });

  it("reports loading while the list is still in flight", () => {
    expect(resolveSession(null, undefined)).toEqual({ kind: "loading" });
  });

  it("reports empty when no sessions exist", () => {
    expect(resolveSession(null, [])).toEqual({ kind: "empty" });
  });

  it("loads a lone session directly", () => {
    expect(resolveSession(null, [session("ses_only")])).toEqual({
      kind: "session",
      sessionId: "ses_only",
    });
  });

  it("offers the picker when several sessions exist", () => {
    const sessions = [session("ses_a"), session("ses_b"), session("ses_c")];
    expect(resolveSession(null, sessions)).toEqual({ kind: "picker", sessions });
  });
});
