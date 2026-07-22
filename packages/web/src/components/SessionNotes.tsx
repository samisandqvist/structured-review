import { useState } from "react";
import { useComments, useCreateComment } from "../api/hooks.js";

/** Review-wide remarks that anchor to no diff line — missing functionality,
 *  absent tests, architectural concerns. Exported as scope:"session" comments
 *  (a GitHub PR review body, not an inline comment). */
export function SessionNotes({ sessionId }: { sessionId: string }) {
  const { data } = useComments(sessionId);
  const createComment = useCreateComment(sessionId);
  const [text, setText] = useState("");
  const [composing, setComposing] = useState(false);
  const notes = data?.comments.filter((c) => c.nodeId === null) ?? [];

  const handleSubmit = () => {
    if (!text.trim()) return;
    createComment.mutate(
      { nodeId: null, text: text.trim() },
      { onSuccess: () => { setText(""); setComposing(false); } }
    );
  };

  return (
    <div style={{ padding: "10px 16px 12px", borderBottom: "1px solid var(--line)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: "var(--display)", fontWeight: 500, fontSize: 15, color: "var(--dim)" }}>
          Review notes
        </span>
        {notes.length > 0 && <span style={{ color: "var(--dim)", fontSize: 14 }}>{notes.length}</span>}
        {!composing && (
          <button
            data-testid="session-note-add"
            className="btn"
            style={{ marginLeft: "auto", fontSize: 13, padding: "1px 8px" }}
            onClick={() => setComposing(true)}
            title="Add a review-wide note (not tied to any line)"
          >
            + note
          </button>
        )}
      </div>
      {notes.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          {notes.map((n) => (
            <div
              key={n.id}
              data-testid="session-note"
              style={{
                padding: "8px 10px",
                background: "var(--surface)",
                border: "1px solid var(--line)",
                borderLeft: "2px solid var(--led-commented)",
                borderRadius: "var(--radius-sm)",
                fontSize: 15,
                lineHeight: 1.55,
                whiteSpace: "pre-wrap",
              }}
            >
              {n.text}
            </div>
          ))}
        </div>
      )}
      {composing && (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 8 }}>
          <textarea
            data-testid="session-note-input"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit();
              if (e.key === "Escape") { setText(""); setComposing(false); }
            }}
            placeholder="Review-wide note — e.g. missing tests, architectural concern…  (⌘↵ to send)"
            style={{ flex: 1, minHeight: 48, fontSize: 15, padding: "8px 10px" }}
          />
          <button
            className="btn btn--primary"
            onClick={handleSubmit}
            disabled={!text.trim()}
            style={{ opacity: text.trim() ? 1 : 0.5 }}
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}
