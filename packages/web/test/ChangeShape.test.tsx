import { render, screen, within, fireEvent } from "@testing-library/react";
import { vi, beforeEach } from "vitest";
import type { ChangeShape } from "../src/api/client.js";
import { ChangeShapeView } from "../src/components/ChangeShape.js";

let shape: ChangeShape | undefined;
vi.mock("../src/api/hooks.js", () => ({
  useShape: () => ({ data: shape }),
}));

const manifestShape: ChangeShape = {
  source: "manifest",
  warnings: ["api lists unknown consumer ghost"],
  components: [
    {
      id: "api",
      description: "HTTP API",
      criticality: "high",
      files: [
        { path: "api/routes/users.ts", status: "modified", contract: "http" },
        { path: "api/engine/run.ts", status: "added" },
        { path: "api/new.ts", status: "renamed", oldPath: "api/old.ts" },
        { path: "api/gone.ts", status: "deleted" },
      ],
      newDirectories: ["api/engine"],
      changedContracts: ["http"],
      consumers: [
        { id: "web", inChange: true },
        { id: "worker", inChange: false },
      ],
    },
    {
      id: "web",
      criticality: "low",
      files: [{ path: "web/app.ts", status: "modified" }],
      newDirectories: [],
      changedContracts: [],
      consumers: [],
    },
  ],
  unassigned: [{ path: "tools/run.sh", status: "added" }],
  outsideConsumers: [
    {
      id: "worker",
      description: "Queue worker",
      criticality: "normal",
      via: [{ component: "api", contracts: ["http"] }],
    },
  ],
};

beforeEach(() => {
  shape = undefined;
});

describe("ChangeShapeView", () => {
  it("shows only the walk prompt while the shape loads", () => {
    render(<ChangeShapeView sessionId="s" />);
    expect(screen.getByText("Pick a node to start the walk")).toBeInTheDocument();
    expect(screen.queryByText("Shape of the change")).not.toBeInTheDocument();
  });

  it("summarizes components, contracts and outside consumers from a manifest", () => {
    shape = manifestShape;
    render(<ChangeShapeView sessionId="s" />);
    expect(screen.getByText("component manifest")).toBeInTheDocument();
    expect(screen.getByTestId("shape-summary")).toHaveTextContent(
      "6 files in 2 components · 1 contract changed · 1 consumer outside the change",
    );
    expect(screen.getByText(/unknown consumer ghost/)).toBeInTheDocument();

    const [api, web] = screen.getAllByTestId("shape-component");
    expect(within(api!).getByText("high")).toBeInTheDocument();
    expect(within(api!).getByText("HTTP API")).toBeInTheDocument();
    expect(within(api!).getByText("1 modified, 1 added, 1 renamed, 1 deleted")).toBeInTheDocument();
    expect(within(api!).getByText("new directories: api/engine")).toBeInTheDocument();
    expect(within(api!).getByText("web (in change)")).toBeInTheDocument();
    expect(within(api!).getByText("worker (outside)")).toBeInTheDocument();
    expect(within(api!).getByText("api/old.ts → api/new.ts")).toBeInTheDocument();
    expect(within(web!).queryByText(/contracts changed/)).not.toBeInTheDocument();

    const outside = screen.getByTestId("shape-outside");
    expect(within(outside).getByText("Queue worker")).toBeInTheDocument();
    expect(within(outside).getByText("uses http of api")).toBeInTheDocument();
    expect(within(screen.getByTestId("shape-unassigned")).getByText("tools/run.sh")).toBeInTheDocument();
  });

  it("names inferred components, with a hint to add a manifest, and singular counts", () => {
    shape = {
      source: "inferred",
      warnings: [],
      components: [
        {
          id: "lib",
          criticality: "normal",
          files: [{ path: "lib/a.ts", status: "modified" }],
          newDirectories: [],
          changedContracts: [],
          consumers: [],
        },
      ],
      unassigned: [],
      outsideConsumers: [],
    };
    render(<ChangeShapeView sessionId="s" />);
    const badge = screen.getByText("inferred components");
    expect(badge.getAttribute("title")).toContain("Add .review-components.json");
    expect(screen.getByTestId("shape-summary")).toHaveTextContent(/^1 file in 1 component$/);
    expect(screen.queryByTestId("shape-outside")).not.toBeInTheDocument();
    expect(screen.queryByTestId("shape-unassigned")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("files"));
    expect(screen.getByText("lib/a.ts")).toBeInTheDocument();
  });
});
