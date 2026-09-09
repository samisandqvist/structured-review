import { describe, it, expect, vi, afterEach } from "vitest";
import { api } from "../src/api/client.js";

function mockFetch(body: unknown) {
  const spy = vi.fn(async () => ({ ok: true, json: async () => body }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe("comment API client", () => {
  it("updateComment PATCHes the comment with only the new text", async () => {
    const spy = mockFetch({ comment: { id: "c1", text: "new" } });
    const res = await api.updateComment("s1", "c1", "new");
    expect(res.comment.text).toBe("new");
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/sessions\/s1\/comments\/c1$/);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ text: "new" });
  });

  it("deleteComment sends DELETE to the comment URL", async () => {
    const spy = mockFetch({ deleted: "c1" });
    const res = await api.deleteComment("s1", "c1");
    expect(res.deleted).toBe("c1");
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/sessions\/s1\/comments\/c1$/);
    expect(init.method).toBe("DELETE");
  });
});
