import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionNotes } from "../src/components/SessionNotes.js";

const mutateSpy = vi.fn((_args: { nodeId: string | null; text: string }, opts?: { onSuccess?: () => void }) =>
  opts?.onSuccess?.()
);

const updateSpy = vi.fn((_args: { commentId: string; text: string }, opts?: { onSuccess?: () => void }) =>
  opts?.onSuccess?.()
);
const deleteSpy = vi.fn();

vi.mock("../src/api/hooks.js", () => ({
  useComments: () => ({
    data: {
      comments: [
        { id: "c1", sessionId: "s1", nodeId: "n1", hunkSnippet: "x", text: "node comment", structuralContext: "", createdAt: 1000, anchor: null },
        { id: "c2", sessionId: "s1", nodeId: null, hunkSnippet: "", text: "no tests anywhere for retries", structuralContext: "", createdAt: 1001, anchor: null },
      ],
    },
    isLoading: false,
  }),
  useCreateComment: () => ({ mutate: mutateSpy }),
  useUpdateComment: () => ({ mutate: updateSpy }),
  useDeleteComment: () => ({ mutate: deleteSpy }),
}));

function renderWithProviders(ui: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

describe("SessionNotes", () => {
  beforeEach(() => {
    mutateSpy.mockClear();
    updateSpy.mockClear();
    deleteSpy.mockClear();
  });

  it("lists only session-wide comments, not node comments", () => {
    renderWithProviders(<SessionNotes sessionId="s1" />);
    expect(screen.getByText("no tests anywhere for retries")).toBeInTheDocument();
    expect(screen.queryByText("node comment")).not.toBeInTheDocument();
  });

  it("submits a note with nodeId null", async () => {
    renderWithProviders(<SessionNotes sessionId="s1" />);
    fireEvent.click(screen.getByTestId("session-note-add"));
    fireEvent.change(screen.getByTestId("session-note-input"), { target: { value: "big picture concern" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() =>
      expect(mutateSpy).toHaveBeenCalledWith({ nodeId: null, text: "big picture concern" }, expect.anything())
    );
  });

  it("deletes a note via its ✕ button", () => {
    renderWithProviders(<SessionNotes sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("delete comment"));
    expect(deleteSpy).toHaveBeenCalledWith("c2");
  });

  it("edits a note and saves the new text", async () => {
    renderWithProviders(<SessionNotes sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("edit comment"));
    fireEvent.change(screen.getByDisplayValue("no tests anywhere for retries"), { target: { value: "retries are untested" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith({ commentId: "c2", text: "retries are untested" }, expect.anything())
    );
  });

  it("discards a note edit on Escape", () => {
    renderWithProviders(<SessionNotes sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("edit comment"));
    const ta = screen.getByDisplayValue("no tests anywhere for retries");
    fireEvent.change(ta, { target: { value: "draft" } });
    fireEvent.keyDown(ta, { key: "Escape" });
    expect(screen.queryByDisplayValue("draft")).not.toBeInTheDocument();
    expect(screen.getByText("no tests anywhere for retries")).toBeInTheDocument();
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
