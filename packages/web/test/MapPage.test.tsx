// The component map page against a mocked hub and the real ELK layout.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MapPage, levelFromUrl } from "../src/map/MapPage.js";
import { navigateToSession } from "../src/navigation.js";
import { useUIStore } from "../src/store/ui.js";
import { fixtureChange, fixtureMap, fixtureReview } from "./map-fixture.js";
import type { MapChange } from "../src/map/types.js";

vi.mock("../src/navigation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/navigation.js")>()),
  navigateToSession: vi.fn(),
}));

function stubMap(status: number, extra: Record<string, unknown> = {}) {
  const body = { model: {}, map: fixtureMap(), headSha: "abc", createdAt: 1, stale: false, ...extra };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: status === 200, status, json: async () => body })),
  );
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MapPage sessionId="s1" />
    </QueryClientProvider>,
  );
}

const panel = () => screen.getByTestId("map-panel");
const node = (container: HTMLElement, id: string) =>
  waitFor(() => {
    const el = container.querySelector(`[data-node="${id}"]`);
    if (!el) throw new Error(`no node ${id}`);
    return el;
  });

beforeEach(() => window.history.replaceState(null, "", "/?session=s1&view=map"));
afterEach(() => vi.unstubAllGlobals());

describe("levelFromUrl", () => {
  const map = fixtureMap();
  it("reads a level with parts, the system level, or falls back to the default", () => {
    expect(levelFromUrl(map, "?level=core")).toBe("core");
    expect(levelFromUrl(map, "?level=system")).toBeNull();
    expect(levelFromUrl(map, "?level=store")).toBe("orchestrator");
    expect(levelFromUrl(map, "")).toBe("orchestrator");
  });
});

describe("MapPage", () => {
  it("draws the default level with its parts and summarizes it in the panel", async () => {
    stubMap(200);
    const { container } = renderPage();
    await node(container, "core");
    expect(container.querySelector(".d-frame text.title")!.textContent).toBe("Job orchestrator");
    expect(container.querySelector('[data-node="core"] text.sub')!.textContent).toBe("2 parts · open");
    expect(
      within(panel()).getByText("6/6 cross-component references are call sites of an interface; 1 undeclared.", {
        exact: false,
      }),
    ).toBeTruthy();
    expect(panel().textContent).toContain("Operator API uses Job state writes of Persistence");
    expect(panel().textContent).toContain("the core owns all job state");
    expect(panel().textContent).toContain("cs root 'tools' is not yet mapped");
  });

  it("shows an interface's bindings and call sites when its port is clicked", async () => {
    stubMap(200);
    const { container } = renderPage();
    await node(container, "store");
    fireEvent.click(container.querySelector('[data-port="store|reads|provide"]')!);
    expect(panel().textContent).toContain("Read models");
    expect(panel().textContent).toContain("src/store/jobs.ts:1");
    expect(panel().textContent).toContain("src/core/engine/run.ts:3");
    expect(container.querySelector(".cmap-svg")!.classList.contains("dimmed")).toBe(true);
    expect(
      container.querySelector('[data-edge="core|reads|require>store|reads|provide"]')!.classList.contains("hl"),
    ).toBe(true);
  });

  it("opens a part from the panel, updates the URL and returns through the breadcrumb", async () => {
    stubMap(200);
    const { container } = renderPage();
    fireEvent.click(await node(container, "core"));
    fireEvent.click(within(panel()).getByRole("button", { name: "Open Core (2 parts)" }));
    expect(window.location.search).toBe("?session=s1&view=map&level=core");
    await node(container, "engine");
    expect(container.querySelector(".d-frame text.title")!.textContent).toBe("Core");
    fireEvent.click(screen.getByRole("button", { name: "Job orchestrator" }));
    await node(container, "api");
    fireEvent.click(screen.getByRole("button", { name: "System" }));
    await node(container, "feeds");
    expect(window.location.search).toBe("?session=s1&view=map&level=system");
  });

  it("opens a part on double-click and follows the browser's back button", async () => {
    stubMap(200);
    const { container } = renderPage();
    fireEvent.doubleClick(await node(container, "core"));
    await node(container, "engine");
    window.history.replaceState(null, "", "/?session=s1&view=map&level=system");
    fireEvent(window, new PopStateEvent("popstate"));
    await node(container, "operators");
  });
});

describe("MapPage panel and states", () => {
  it("shows a component's details and type-only dependencies", async () => {
    stubMap(200);
    const { container } = renderPage();
    fireEvent.click(await node(container, "api"));
    expect(panel().textContent).toContain("Operator API meaning");
    expect(panel().textContent).toContain("Operator API → Persistence: 2 references (Job)");
    fireEvent.click(within(panel()).getByRole("button", { name: "Read models" }));
    expect(panel().textContent).toContain("Provided by → required by");
  });

  it("selects an interface from an undeclared finding", async () => {
    stubMap(200);
    const { container } = renderPage();
    await node(container, "api");
    fireEvent.click(within(panel()).getByRole("button", { name: /Operator API uses Job state writes/ }));
    expect(panel().textContent).toContain("Red: uses this interface, but the model does not list it as a requirer.");
  });

  it("warns when the code changed since the map was built", async () => {
    stubMap(200, { stale: true, staleReason: "head-moved" });
    renderPage();
    expect((await screen.findByTestId("map-stale")).textContent).toContain("new commits");
  });

  it("asks for a map when the session has none", async () => {
    stubMap(404);
    renderPage();
    expect((await screen.findByTestId("map-empty")).textContent).toContain("No component map for this session");
  });

  it("reports other load failures", async () => {
    stubMap(500);
    renderPage();
    expect((await screen.findByTestId("map-empty")).textContent).toContain("Couldn't load the map");
  });
});

describe("MapPage canvas interactions", () => {
  const transform = (container: HTMLElement) => container.querySelector(".cmap-svg > g")!.getAttribute("transform");

  it("zooms with the wheel and the buttons and fits back", async () => {
    stubMap(200);
    const { container } = renderPage();
    await node(container, "core");
    await waitFor(() => expect(transform(container)).toBe("translate(8,8) scale(1)"));
    const start = transform(container);
    fireEvent.wheel(container.querySelector(".cmap-canvas")!, { deltaY: -200 });
    expect(transform(container)).not.toBe(start);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(transform(container)).toBe(start);
  });

  it("pans by dragging and clears the selection on a background click", async () => {
    stubMap(200);
    const { container } = renderPage();
    fireEvent.click(await node(container, "api"));
    const canvas = container.querySelector(".cmap-canvas")!;
    const start = transform(container);
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 60, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    expect(transform(container)).not.toBe(start);
    expect(panel().textContent).toContain("Operator API meaning");
    fireEvent.pointerMove(canvas, { clientX: 70, clientY: 40 });
    fireEvent.pointerDown(canvas, { clientX: 5, clientY: 5, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    expect(panel().textContent).toContain("parts, ");
  });

  it("does not start a drag on a diagram element and selects an interface from a connector", async () => {
    stubMap(200);
    const { container } = renderPage();
    const api = await node(container, "api");
    fireEvent.pointerDown(api, { clientX: 1, clientY: 1 });
    fireEvent.pointerUp(api);
    fireEvent.click(container.querySelector('[data-edge="api|writes|require>store|writes|provide"]')!);
    expect(panel().textContent).toContain("Job state writes");
    expect(panel().textContent).toContain("the core owns all job state");
  });
});

describe("MapPage detail variants", () => {
  it("describes the system level, external systems and cross-process interfaces", async () => {
    window.history.replaceState(null, "", "/?session=s1&view=map&level=system");
    stubMap(200);
    const { container } = renderPage();
    fireEvent.click(await node(container, "feeds"));
    expect(panel().textContent).toContain("External system");
    expect(panel().textContent).not.toContain("Files (");
    fireEvent.click(within(panel()).getByRole("button", { name: "Item feed" }));
    expect(panel().textContent).toContain("Cross-process interface · http");
    expect(panel().textContent).toContain("Evidence (1 file)");
    expect(panel().textContent).toContain("None in this codebase");
    fireEvent.click(within(panel()).getByRole("button", { name: "Job orchestrator" }));
    expect(panel().textContent).toContain("Open Job orchestrator (3 parts)");
    fireEvent.click(container.querySelector(".cmap-canvas")!);
  });

  it("describes the system level when nothing is selected", async () => {
    window.history.replaceState(null, "", "/?session=s1&view=map&level=system");
    stubMap(200);
    const { container } = renderPage();
    await node(container, "feeds");
    expect(panel().textContent).toContain("Job orchestrator and its neighbours");
  });
});

describe("MapPage edge cases", () => {
  it("truncates a long meaning in the frame and ignores double-clicks on leaves", async () => {
    const map = fixtureMap();
    map.components[1]!.meaning = "x".repeat(120);
    stubMap(200, { map });
    const { container } = renderPage();
    fireEvent.doubleClick(await node(container, "store"));
    expect(container.querySelector(".d-frame text.meaning")!.textContent).toHaveLength(89);
    expect(window.location.search).toBe("?session=s1&view=map");
  });

  it("names working-tree edits as the reason a map is stale", async () => {
    stubMap(200, { stale: true, staleReason: "working-tree-changed" });
    renderPage();
    expect((await screen.findByTestId("map-stale")).textContent).toContain("working tree edits");
  });

  it("treats a tiny pointer movement as a click", async () => {
    stubMap(200);
    const { container } = renderPage();
    fireEvent.click(await node(container, "api"));
    const canvas = container.querySelector(".cmap-canvas")!;
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 11, clientY: 11 });
    fireEvent.pointerUp(canvas);
    expect(panel().textContent).toContain("Coverage");
  });

  it("leaves out empty sections for a clean map and words findings without reserved requirers", async () => {
    const clean = fixtureMap();
    clean.interfaces.find((i) => i.id === "writes")!.sites[0]!.undeclared = false;
    clean.report = { ...clean.report, unclaimedFiles: [], unattributedReferences: 0, utilities: [], gaps: [] };
    stubMap(200, { map: clean });
    const first = renderPage();
    await node(first.container, "api");
    expect(panel().textContent).not.toContain("Undeclared uses");
    expect(panel().textContent).not.toContain("Outside the parts");
    first.unmount();
    const open = fixtureMap();
    open.interfaces.find((i) => i.id === "writes")!.requirers = [];
    stubMap(200, { map: open });
    const second = renderPage();
    await node(second.container, "api");
    expect(panel().textContent).toContain("Operator API uses Job state writes of Persistence.");
  });
});

function stubReview(over: Partial<MapChange> = {}) {
  const { nodes, units, flows } = fixtureReview();
  const change = { ...fixtureChange(), ...over };
  const bodies: [string, unknown][] = [
    ["/map", { model: {}, map: { ...fixtureMap(), change }, headSha: "abc", createdAt: 1 }],
    ["/nodes", { nodes, edges: [] }],
    ["/flows", { flows, orphans: [] }],
    ["/sessions/s1", { session: { id: "s1" }, units, coverage: { changedTotal: 5, covered: 5, unassigned: 0 } }],
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => bodies.find(([path]) => String(url).includes(path))![1],
    })),
  );
}
describe("MapPage in a review", () => {
  it("marks changed components, connectors and contracts", async () => {
    stubReview();
    const { container } = renderPage();
    await waitFor(() => expect(container.querySelector('[data-node="core"] text.chg')).toBeTruthy());
    expect(container.querySelector('[data-node="core"] text.chg')!.textContent).toBe("3 changed · 1 reviewed");
    expect(container.querySelector('[data-node="api"] text.chg')).toBeNull();
    expect(
      container
        .querySelector('[data-edge="api|writes|require>store|writes|provide"]')!
        .classList.contains("chg-changed"),
    ).toBe(true);
    expect(container.querySelector('[data-port="store|reads|provide"]')!.classList.contains("touched")).toBe(true);
    expect(container.querySelector('[data-port="store|new:store:src/store/cache.ts:warm|provide"]')).toBeTruthy();
    expect(panel().textContent).toContain("New surface");
    expect(panel().textContent).toContain("warm");
    expect(panel().textContent).toContain("Contract touched");
    expect(within(panel()).getByRole("button", { name: /n3/ })).toBeTruthy();
  });

  it("lists a changed part's items and opens one in the review", async () => {
    stubReview();
    window.history.replaceState(null, "", "/?session=s1&view=map&level=core");
    const { container } = renderPage();
    fireEvent.click(await node(container, "engine"));
    const items = await within(panel()).findAllByRole("button", { name: /^(n5|n1|t1)/ });
    expect(items.map((b) => b.textContent!.split(" ")[0])).toEqual(["n5", "n1", "t1"]);
    fireEvent.click(items[1]!);
    expect(useUIStore.getState().currentNodeId).toBe("n1");
    expect(navigateToSession).toHaveBeenCalledWith("s1");
  });

  it("selects the interface behind each change line", async () => {
    stubReview();
    const { container } = renderPage();
    await node(container, "core");
    const line = (name: RegExp) => within(panel()).getByRole("button", { name });
    const back = async (level = "orchestrator") => {
      window.history.replaceState(null, "", `/?session=s1&view=map&level=${level}`);
      fireEvent(window, new PopStateEvent("popstate"));
      await waitFor(() => line(level === "core" ? /^Removed: Engine/ : /^New surface: warm/));
    };
    await back("core");
    fireEvent.click(line(/^Removed: Engine/));
    expect(panel().textContent).toContain("Removed call sites");
    await back();
    fireEvent.click(line(/^New surface: warm/));
    expect(panel().textContent).toContain("New surface: warm is used across components");
    await back();
    fireEvent.click(line(/^Contract touched: Read models/));
    expect(panel().textContent).toContain("Contract touched in this change (body: getJob)");
    await back();
    fireEvent.click(line(/^Changed: Operator API/));
    expect(panel().textContent).toContain("New call sites");
  });

  it("shows an interface's change", async () => {
    stubReview();
    const { container } = renderPage();
    await node(container, "store");
    fireEvent.click(container.querySelector('[data-port="store|writes|provide"]')!);
    expect(panel().textContent).toContain("New call sites");
    expect(panel().textContent).toContain("purge → saveJob");
  });
});

describe("MapPage levels in a review", () => {
  it("marks the parts the change adds or removes", async () => {
    stubReview({ addedComponents: ["api"], removedComponents: ["store"] });
    const { container } = renderPage();
    await waitFor(() => expect(container.querySelector('[data-node="api"]')!.classList.contains("added")).toBe(true));
    expect(container.querySelector('[data-node="store"]')!.classList.contains("removed")).toBe(true);
    expect(container.querySelector('[data-node="core"]')!.classList.contains("added")).toBe(false);
    expect(panel().textContent).toContain("New part: Operator API");
    expect(panel().textContent).toContain("Removed part: Persistence");
    fireEvent.click(within(panel()).getByRole("button", { name: /^New part: Operator API/ }));
    expect(panel().textContent).toContain("Operator API meaning");
  });

  it("lists the opened level's own changes and counts the rest", async () => {
    stubReview();
    const { container } = renderPage();
    await node(container, "core");
    await waitFor(() => expect(panel().textContent).toContain("New surface"));
    expect(panel().textContent).not.toContain("Removed: Engine");
    expect(panel().textContent).toContain("1 more change inside the parts");
  });

  it("lists changed files no part claims at their level", async () => {
    stubReview({ unmapped: [{ component: "orchestrator", files: ["src/main.ts", "package.json"] }] });
    const { container } = renderPage();
    await node(container, "core");
    await waitFor(() => expect(panel().textContent).toContain("Changed files no part claims"));
    expect(within(panel()).getByText("package.json")).toBeTruthy();
    expect(within(panel()).queryByText("src/main.ts")).toBeNull();
  });
});
