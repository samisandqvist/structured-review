import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../src/navigation.js", () => ({
  navigateToSession: vi.fn(),
}));

import { SessionPicker } from "../src/components/SessionPicker.js";
import { navigateToSession } from "../src/navigation.js";
import type { ReviewSession } from "../src/api/client.js";

const sessions: ReviewSession[] = [
  { id: "ses_a", branch: "delegation-grants", baseRef: "main", status: "walking", createdAt: Date.UTC(2026, 7, 19, 12, 0) },
  { id: "ses_b", branch: "example-service-fusion", baseRef: "develop", status: "planning", createdAt: Date.UTC(2026, 7, 20, 8, 30) },
];

beforeEach(() => {
  vi.mocked(navigateToSession).mockClear();
});

describe("SessionPicker", () => {
  it("lists each session with branch, base ref, status, and created date", () => {
    render(<SessionPicker sessions={sessions} />);
    expect(screen.getByText("delegation-grants")).toBeInTheDocument();
    expect(screen.getByText("example-service-fusion")).toBeInTheDocument();
    expect(screen.getByText(/main/)).toBeInTheDocument();
    expect(screen.getByText(/develop/)).toBeInTheDocument();
    expect(screen.getByText("walking")).toBeInTheDocument();
    expect(screen.getByText("planning")).toBeInTheDocument();
    expect(screen.getAllByText(/2026/).length).toBe(2);
  });

  it("navigates to the picked session", () => {
    render(<SessionPicker sessions={sessions} />);
    fireEvent.click(screen.getByText("example-service-fusion"));
    expect(navigateToSession).toHaveBeenCalledWith("ses_b");
  });
});
