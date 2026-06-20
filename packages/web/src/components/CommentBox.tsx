import { useState } from "react";
import { useComments, useCreateComment } from "../api/hooks.js";

export function CommentBox({ sessionId, nodeId }: { sessionId: string; nodeId: string }) {
  const { data } = useComments(sessionId);
  const createComment = useCreateComment(sessionId);
  const [text, setText] = useState("");
  const comments = data?.comments.filter((c) => c.nodeId === nodeId) ?? [];

  const handleSubmit = () => {
    if (!text.trim()) return;
    createComment.mutate(
      { nodeId, hunkSnippet: "", text: text.trim(), structuralContext: "" },
      { onSuccess: () => setText("") },
    );
  };

  return (
    <div style={{ borderTop: "1px solid #333", padding: "8px" }}>
      <div style={{ marginBottom: "8px" }}>
        <strong>Comments</strong>
        {comments.map((c) => (
          <div key={c.id} style={{ margin: "4px 0", padding: "4px", background: "#222" }}>{c.text}</div>
        ))}
      </div>
      <div style={{ display: "flex", gap: "4px" }}>
        <textarea value={text} onChange={(e) => setText(e.target.value)}
          placeholder="Leave a review comment..."
          style={{ flex: 1, minHeight: "40px", background: "#222", color: "#fff", border: "1px solid #555" }}
        />
        <button onClick={handleSubmit} style={{ padding: "4px 12px" }}>Submit</button>
      </div>
    </div>
  );
}
