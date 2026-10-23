import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, afterEach } from "vitest";
import { api, type ChangeShape } from "../src/api/client.js";
import { useShape } from "../src/api/hooks.js";

const shape: ChangeShape = { source: "inferred", warnings: [], components: [], unassigned: [], outsideConsumers: [] };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("shape API client", () => {
  it("getShape reads the session's shape", async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => shape }));
    vi.stubGlobal("fetch", spy);
    expect(await api.getShape("s1")).toEqual(shape);
    const [url] = spy.mock.calls[0] as unknown as [string];
    expect(url).toMatch(/\/sessions\/s1\/shape$/);
  });

  it("useShape queries the shape of the given session", async () => {
    const getShape = vi.spyOn(api, "getShape").mockResolvedValue(shape);
    function Probe() {
      const { data } = useShape("s2");
      return <span>{data ? data.source : "loading"}</span>;
    }
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Probe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("inferred")).toBeInTheDocument());
    expect(getShape).toHaveBeenCalledWith("s2");
  });
});
