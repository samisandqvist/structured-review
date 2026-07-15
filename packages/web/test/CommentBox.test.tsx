import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommentBox } from "../src/components/CommentBox.js";

const mutateSpy = vi.fn((_args: { nodeId: string; text: string }, opts?: { onSuccess?: () => void }) =>
  opts?.onSuccess?.()
);

vi.mock("../src/api/hooks.js", () => ({
  useComments: () => ({
    data: { comments: [{ id: "c1", sessionId: "s1", nodeId: "n1", hunkSnippet: "x", text: "existing comment", structuralContext: "callers: A", createdAt: 1000 }] },
    isLoading: false,
  }),
  useCreateComment: () => ({ mutate: mutateSpy }),
  useUpdateNodeStatus: () => ({ mutate: vi.fn() }),
}));

function renderWithProviders(ui: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

describe("CommentBox", () => {
  it("lists existing comments", () => {
    renderWithProviders(<CommentBox sessionId="s1" nodeId="n1" />);
    expect(screen.getByText("existing comment")).toBeInTheDocument();
  });
  it("shows a textarea for new comments", () => {
    renderWithProviders(<CommentBox sessionId="s1" nodeId="n1" />);
    expect(screen.getByPlaceholderText(/Leave a review comment/)).toBeInTheDocument();
  });
  it("submits and clears on success", async () => {
    renderWithProviders(<CommentBox sessionId="s1" nodeId="n1" />);
    const ta = screen.getByPlaceholderText(/Leave a review comment/);
    fireEvent.change(ta, { target: { value: "new text" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(ta).toHaveValue(""));
  });
  it("submits only nodeId and text — no client-authored snippet/context", async () => {
    renderWithProviders(<CommentBox sessionId="s1" nodeId="n1" />);
    const ta = screen.getByPlaceholderText(/Leave a review comment/);
    fireEvent.change(ta, { target: { value: "new text" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() =>
      expect(mutateSpy).toHaveBeenCalledWith({ nodeId: "n1", text: "new text" }, expect.anything())
    );
  });
});
