import { useState } from "react";
import {
  useComments,
  useCreateComment,
  useUpdateNodeStatus,
} from "../api/hooks.js";

export function CommentBox({
  sessionId,
  nodeId,
}: {
  sessionId: string;
  nodeId: string;
}) {
  const { data } = useComments(sessionId);
  const createComment = useCreateComment(sessionId);
  const updateStatus = useUpdateNodeStatus(sessionId);
  const [text, setText] = useState("");
  const comments = data?.comments.filter((c) => c.nodeId === nodeId) ?? [];

  const handleSubmit = () => {
    if (!text.trim()) return;
    createComment.mutate(
      { nodeId, text: text.trim() },
      {
        onSuccess: () => {
          setText("");
          // Leaving a comment is what marks a node reviewed-commented — there
          // is no separate button for it.
          updateStatus.mutate({ nodeId, reviewStatus: "reviewed-commented" });
        },
      }
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
        <h3 style={{ fontSize: 17, color: "var(--text)", letterSpacing: "0.02em" }}>
          Comments
        </h3>
        <span style={{ color: "var(--dim)", fontSize: 15 }}>
          {comments.length}
        </span>
      </div>

      {comments.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 12 }}>
          {comments.map((c) => (
            <div
              key={c.id}
              style={{
                padding: "10px 12px",
                background: "var(--surface)",
                border: "1px solid var(--line)",
                borderLeft: "2px solid var(--led-commented)",
                borderRadius: "var(--radius-sm)",
                fontSize: 15,
                lineHeight: 1.55,
                color: "var(--text)",
              }}
            >
              {c.text}
            </div>
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
          placeholder="Leave a review comment…  (⌘↵ to send)"
          style={{ flex: 1, minHeight: 58, fontSize: 15, padding: "11px 13px" }}
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
