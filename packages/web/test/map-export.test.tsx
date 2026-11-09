// The exported map page's entry: it reads the map embedded in the page and
// draws it without a hub.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { fixtureMap } from "./map-fixture.js";

function page(embedded?: string) {
  document.body.innerHTML =
    '<div id="root"></div>' +
    (embedded === undefined ? "" : `<script type="application/json" id="srev-map">${embedded}</script>`);
}
const load = () => import("../src/map-export.js");

beforeEach(() => {
  vi.resetModules();
  window.sessionStorage.clear();
});

describe("exported map page", () => {
  it("draws the embedded map without a hub link", async () => {
    window.history.replaceState(null, "", "/component-map.html");
    page(JSON.stringify({ model: {}, map: fixtureMap(), headSha: "abc", createdAt: 1, stale: false }));
    await load();
    expect(await screen.findByTestId("map-panel")).toBeTruthy();
    await waitFor(() => expect(document.querySelector('[data-node="api"]')).not.toBeNull());
    expect(screen.queryByRole("link", { name: "Review" })).toBeNull();
    fireEvent.doubleClick(document.querySelector('[data-node="core"]')!);
    await waitFor(() => expect(document.querySelector('[data-node="engine"]')).not.toBeNull());
    expect(window.location.pathname).toBe("/component-map.html");
    expect(window.location.search).toBe("");
  });

  it("says so when the page carries no map or an unreadable one", async () => {
    page();
    await load();
    expect(await screen.findByText("This page carries no component map.")).toBeTruthy();
    vi.resetModules();
    page("{");
    const { embeddedMap } = await load();
    expect(embeddedMap(document)).toBeNull();
    expect(await screen.findByText("This page carries no component map.")).toBeTruthy();
  });

  it("renders nothing without a root element", async () => {
    document.body.innerHTML = "";
    const { embeddedMap } = await load();
    expect(embeddedMap(document)).toBeNull();
    expect(document.body.innerHTML).toBe("");
  });
});
