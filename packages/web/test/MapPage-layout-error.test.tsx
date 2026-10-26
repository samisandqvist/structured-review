// The map page reports a failed layout instead of drawing nothing.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fixtureMap } from "./map-fixture.js";

vi.mock("elkjs/lib/elk.bundled.js", () => ({
  default: class {
    layout() {
      return Promise.reject(new Error("bad graph"));
    }
  },
}));

const { MapPage } = await import("../src/map/MapPage.js");

describe("MapPage layout failure", () => {
  it("shows the layout error", async () => {
    const body = { model: {}, map: fixtureMap(), headSha: "a", createdAt: 1 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => body })),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MapPage sessionId="s1" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Layout failed: bad graph")).toBeTruthy();
    vi.unstubAllGlobals();
  });
});
