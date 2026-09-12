import { useState, type ReactNode } from "react";
import { useUpdateComment, useDeleteComment } from "../api/hooks.js";
import type { Comment } from "../api/client.js";

/** One stored comment with inline edit and delete. Shared by the node comment
 *  list and the session-wide review notes; `leading` renders before the text
 *  (the anchor chip) and stays visible while editing. */
export function CommentCard({
  sessionId,
  comment,
  fontSize,
  leading,
  testId,
}: {
  sessionId: string;
  comment: Comment;
  fontSize: number;
  leading?: ReactNode;
  testId?: string;
}) {
  const updateComment = useUpdateComment(sessionId);
  const deleteComment = useDeleteComment(sessionId);
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;

  const save = () => {
    const text = draft?.trim();
    if (!text) return;
    updateComment.mutate({ commentId: comment.id, text }, { onSuccess: () => setDraft(null) });
  };

  const iconBtn = { fontSize: fontSize - 3, padding: "0 6px", lineHeight: 1.6 } as const;

  return (
    <div
      data-testid={testId}
      style={{
        padding: "8px 10px 8px 12px",
        background: "var(--surface)",
        border: "1px solid var(--line)",
        borderLeft: "2px solid var(--led-commented)",
        borderRadius: "var(--radius-sm)",
        fontSize,
        lineHeight: 1.55,
        color: "var(--text)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0, whiteSpace: "pre-wrap" }}>
          {leading}
          {editing ? (
            <textarea
              autoFocus
              aria-label="edit comment text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
                if (e.key === "Escape") setDraft(null);
              }}
              style={{ width: "100%", minHeight: 48, fontSize, padding: "6px 8px", marginTop: leading ? 6 : 0 }}
            />
          ) : (
            comment.text
          )}
        </div>
        {!editing && (
          <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
            <button
              aria-label="edit comment"
              title="Edit"
              className="btn"
              style={iconBtn}
              onClick={() => setDraft(comment.text)}
            >
              ✎
            </button>
            <button
              aria-label="delete comment"
              title="Delete"
              className="btn"
              style={iconBtn}
              onClick={() => deleteComment.mutate(comment.id)}
            >
              ✕
            </button>
          </div>
        )}
      </div>
      {editing && (
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 6 }}>
          <button
            className="btn"
            style={{ fontSize: fontSize - 2, padding: "2px 10px" }}
            onClick={() => setDraft(null)}
          >
            Cancel
          </button>
          <button
            className="btn btn--primary"
            style={{ fontSize: fontSize - 2, padding: "2px 10px", opacity: draft.trim() ? 1 : 0.5 }}
            disabled={!draft.trim()}
            onClick={save}
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}
