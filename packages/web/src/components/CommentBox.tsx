import { useState } from "react";
import { useComments, useCreateComment, useUpdateNodeStatus } from "../api/hooks.js";
import { useUIStore } from "../store/ui.js";
import { selectionLabel } from "./DiffView.js";
import { CommentCard } from "./CommentCard.js";

// Both Meta+Enter and Ctrl+Enter submit; the hint names the key the viewer's
// platform actually has (⌘ means nothing on a Linux/Windows keyboard).
const SEND_KEY = /Mac|iP(hone|ad|od)/.test(
  typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent,
)
  ? "⌘↵"
  : "Ctrl+↵";

export function CommentBox({ sessionId, nodeId }: { sessionId: string; nodeId: string }) {
  const { data } = useComments(sessionId);
  const createComment = useCreateComment(sessionId);
  const updateStatus = useUpdateNodeStatus(sessionId);
  const [text, setText] = useState("");
  const comments = data?.comments.filter((c) => c.nodeId === nodeId) ?? [];
  const lineSelection = useUIStore((s) => s.lineSelection);
  const setLineSelection = useUIStore((s) => s.setLineSelection);
  const requestAnchorHighlight = useUIStore((s) => s.requestAnchorHighlight);

  const handleSubmit = () => {
    if (!text.trim()) return;
    createComment.mutate(
      lineSelection ? { nodeId, text: text.trim(), anchor: lineSelection.anchor } : { nodeId, text: text.trim() },
      {
        onSuccess: () => {
          setText("");
          setLineSelection(null);
          // Leaving a comment is what marks a node reviewed-commented — there
          // is no separate button for it.
          updateStatus.mutate({ nodeId, reviewStatus: "reviewed-commented" });
        },
      },
    );
  };

  return (
    <div
      style={{
        borderTop: "1px solid var(--line)",
        padding: "14px 16px 16px",
        background: "var(--panel)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 11,
        }}
      >
        <h3 style={{ fontSize: 19, color: "var(--text)", letterSpacing: "0.02em" }}>Comments</h3>
        <span style={{ color: "var(--dim)", fontSize: 17 }}>{comments.length}</span>
      </div>

      {lineSelection && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span
            style={{
              fontSize: 15,
              fontFamily: "var(--mono)",
              color: "var(--text)",
              background: "var(--surface)",
              border: "1px solid var(--line-bright)",
              borderRadius: 4,
              padding: "2px 8px",
            }}
          >
            commenting on {lineSelection.label}
          </span>
          <button
            aria-label="clear line selection"
            className="btn"
            onClick={() => setLineSelection(null)}
            style={{ fontSize: 14, padding: "1px 7px" }}
          >
            ✕
          </button>
        </div>
      )}

      {comments.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 12 }}>
          {comments.map((c) => (
            <CommentCard
              key={c.id}
              sessionId={sessionId}
              comment={c}
              fontSize={17}
              leading={
                c.anchor ? (
                  <button
                    onClick={() => requestAnchorHighlight(c.anchor!)}
                    style={{
                      display: "inline-block",
                      marginRight: 8,
                      fontSize: 14,
                      fontFamily: "var(--mono)",
                      color: "var(--dim)",
                      background: "transparent",
                      border: "1px solid var(--line)",
                      borderRadius: 4,
                      padding: "0 6px",
                      cursor: "pointer",
                    }}
                  >
                    {selectionLabel(c.anchor)}
                  </button>
                ) : undefined
              }
            />
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
        <textarea
          data-testid="comment-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit();
          }}
          placeholder={`Leave a review comment…  (${SEND_KEY} to send)`}
          style={{ flex: 1, minHeight: 58, fontSize: 17, padding: "11px 13px" }}
        />
        <button
          className="btn btn--primary btn--lg"
          onClick={handleSubmit}
          disabled={!text.trim()}
          style={{ opacity: text.trim() ? 1 : 0.5 }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
