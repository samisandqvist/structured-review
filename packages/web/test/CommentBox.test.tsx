import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommentBox } from "../src/components/CommentBox.js";
import { useUIStore } from "../src/store/ui.js";

const anchor = { startLine: 11, startSide: "new" as const, endLine: 12, endSide: "new" as const };

const mutateSpy = vi.fn((_args: { nodeId: string; text: string }, opts?: { onSuccess?: () => void }) =>
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
        { id: "c1", sessionId: "s1", nodeId: "n1", hunkSnippet: "x", text: "existing comment", structuralContext: "callers: A", createdAt: 1000, anchor: null },
        { id: "c2", sessionId: "s1", nodeId: "n1", hunkSnippet: "x", text: "anchored one", structuralContext: "callers: A", createdAt: 1001, anchor: { startLine: 11, startSide: "new", endLine: 12, endSide: "new" } },
      ],
    },
    isLoading: false,
  }),
  useCreateComment: () => ({ mutate: mutateSpy }),
  useUpdateNodeStatus: () => ({ mutate: vi.fn() }),
  useUpdateComment: () => ({ mutate: updateSpy }),
  useDeleteComment: () => ({ mutate: deleteSpy }),
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

describe("anchored comments", () => {
  beforeEach(() => {
    mutateSpy.mockClear();
    useUIStore.setState({ lineSelection: null, pendingAnchorHighlight: null });
  });

  it("shows the selection chip and submits the anchor", async () => {
    useUIStore.setState({ lineSelection: { startIdx: 2, endIdx: 3, anchor, label: "lines +11…+12" } });
    renderWithProviders(<CommentBox sessionId="s1" nodeId="n1" />);
    // Scoped to "commenting on …" (the chip's own text) rather than the bare label,
    // since the mocked comment c2 also renders a line-chip with the identical
    // "lines +11…+12" label and would otherwise make this query ambiguous.
    expect(screen.getByText(/commenting on lines \+11…\+12/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Leave a review comment/), { target: { value: "on these lines" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() =>
      expect(mutateSpy).toHaveBeenCalledWith({ nodeId: "n1", text: "on these lines", anchor }, expect.anything())
    );
    expect(useUIStore.getState().lineSelection).toBeNull(); // cleared on success
  });

  it("names the platform's send key in the placeholder (Ctrl on non-mac)", () => {
    // jsdom reports a non-mac platform; a ⌘ hint means nothing on Linux/Windows.
    renderWithProviders(<CommentBox sessionId="s1" nodeId="n1" />);
    expect(screen.getByPlaceholderText(/Ctrl\+↵ to send/)).toBeInTheDocument();
  });

  it("clears the selection via the chip's ✕ without commenting", () => {
    useUIStore.setState({ lineSelection: { startIdx: 2, endIdx: 3, anchor, label: "lines +11…+12" } });
    renderWithProviders(<CommentBox sessionId="s1" nodeId="n1" />);
    fireEvent.click(screen.getByLabelText("clear line selection"));
    expect(useUIStore.getState().lineSelection).toBeNull();
  });

  it("renders an anchored comment with a line chip that requests re-highlight", () => {
    // extend the mocked useComments data with an anchored comment for this test:
    // update the vi.mock factory's comments array to include
    // { id: "c2", …, text: "anchored one", anchor: { startLine: 11, startSide: "new", endLine: 12, endSide: "new" } }
    renderWithProviders(<CommentBox sessionId="s1" nodeId="n1" />);
    fireEvent.click(screen.getByText(/lines \+11…\+12/));
    expect(useUIStore.getState().pendingAnchorHighlight).toEqual(anchor);
  });

  it("submits without anchor when there is no selection (unchanged payload)", async () => {
    renderWithProviders(<CommentBox sessionId="s1" nodeId="n1" />);
    fireEvent.change(screen.getByPlaceholderText(/Leave a review comment/), { target: { value: "plain" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() =>
      expect(mutateSpy).toHaveBeenCalledWith({ nodeId: "n1", text: "plain" }, expect.anything())
    );
  });
});

describe("editing and deleting comments", () => {
  beforeEach(() => {
    updateSpy.mockClear();
    deleteSpy.mockClear();
  });

  it("deletes a comment via its ✕ button", () => {
    renderWithProviders(<CommentBox sessionId="s1" nodeId="n1" />);
    fireEvent.click(screen.getAllByLabelText("delete comment")[0]);
    expect(deleteSpy).toHaveBeenCalledWith("c1");
  });

  it("edits a comment and saves the new text", async () => {
    renderWithProviders(<CommentBox sessionId="s1" nodeId="n1" />);
    fireEvent.click(screen.getAllByLabelText("edit comment")[0]);
    const ta = screen.getByDisplayValue("existing comment");
    fireEvent.change(ta, { target: { value: "  revised comment " } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith({ commentId: "c1", text: "revised comment" }, expect.anything())
    );
    // Back to display mode after a successful save.
    expect(screen.queryByDisplayValue(/revised comment/)).not.toBeInTheDocument();
  });

  it("saves an edit with Ctrl+Enter", async () => {
    renderWithProviders(<CommentBox sessionId="s1" nodeId="n1" />);
    fireEvent.click(screen.getAllByLabelText("edit comment")[0]);
    const ta = screen.getByDisplayValue("existing comment");
    fireEvent.change(ta, { target: { value: "quick save" } });
    fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith({ commentId: "c1", text: "quick save" }, expect.anything())
    );
  });

  it("discards the draft on Escape or Cancel without saving", () => {
    renderWithProviders(<CommentBox sessionId="s1" nodeId="n1" />);
    fireEvent.click(screen.getAllByLabelText("edit comment")[0]);
    const ta = screen.getByDisplayValue("existing comment");
    fireEvent.change(ta, { target: { value: "half-typed" } });
    fireEvent.keyDown(ta, { key: "Escape" });
    expect(screen.queryByDisplayValue("half-typed")).not.toBeInTheDocument();
    expect(screen.getByText("existing comment")).toBeInTheDocument();

    fireEvent.click(screen.getAllByLabelText("edit comment")[0]);
    fireEvent.change(screen.getByDisplayValue("existing comment"), { target: { value: "again" } });
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByDisplayValue("again")).not.toBeInTheDocument();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("disables Save when the draft is blank", () => {
    renderWithProviders(<CommentBox sessionId="s1" nodeId="n1" />);
    fireEvent.click(screen.getAllByLabelText("edit comment")[0]);
    fireEvent.change(screen.getByDisplayValue("existing comment"), { target: { value: "   " } });
    expect(screen.getByText("Save")).toBeDisabled();
  });

  it("keeps the anchor chip visible while editing an anchored comment", () => {
    renderWithProviders(<CommentBox sessionId="s1" nodeId="n1" />);
    fireEvent.click(screen.getAllByLabelText("edit comment")[1]);
    expect(screen.getByDisplayValue("anchored one")).toBeInTheDocument();
    expect(screen.getByText(/lines \+11…\+12/)).toBeInTheDocument();
  });
});
