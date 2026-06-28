import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { useComments, useCreateComment, useUpdateNodeStatus, } from "../api/hooks.js";
export function CommentBox({ sessionId, nodeId, }) {
    const { data } = useComments(sessionId);
    const createComment = useCreateComment(sessionId);
    const updateStatus = useUpdateNodeStatus(sessionId);
    const [text, setText] = useState("");
    const comments = data?.comments.filter((c) => c.nodeId === nodeId) ?? [];
    const handleSubmit = () => {
        if (!text.trim())
            return;
        createComment.mutate({ nodeId, hunkSnippet: "", text: text.trim(), structuralContext: "" }, {
            onSuccess: () => {
                setText("");
                // Leaving a comment is what marks a node reviewed-commented — there
                // is no separate button for it.
                updateStatus.mutate({ nodeId, reviewStatus: "reviewed-commented" });
            },
        });
    };
    return (_jsxs("div", { style: {
            borderTop: "1px solid var(--line)",
            padding: "14px 16px 16px",
            background: "var(--panel)",
        }, children: [_jsxs("div", { style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 11,
                }, children: [_jsx("h3", { style: { fontSize: 17, color: "var(--text)", letterSpacing: "0.02em" }, children: "Comments" }), _jsx("span", { style: { color: "var(--dim)", fontSize: 15 }, children: comments.length })] }), comments.length > 0 && (_jsx("div", { style: { display: "flex", flexDirection: "column", gap: 7, marginBottom: 12 }, children: comments.map((c) => (_jsx("div", { style: {
                        padding: "10px 12px",
                        background: "var(--surface)",
                        border: "1px solid var(--line)",
                        borderLeft: "2px solid var(--led-commented)",
                        borderRadius: "var(--radius-sm)",
                        fontSize: 15,
                        lineHeight: 1.55,
                        color: "var(--text)",
                    }, children: c.text }, c.id))) })), _jsxs("div", { style: { display: "flex", gap: 10, alignItems: "flex-end" }, children: [_jsx("textarea", { value: text, onChange: (e) => setText(e.target.value), onKeyDown: (e) => {
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                                handleSubmit();
                        }, placeholder: "Leave a review comment\u2026  (\u2318\u21B5 to send)", style: { flex: 1, minHeight: 58, fontSize: 15, padding: "11px 13px" } }), _jsx("button", { className: "btn btn--primary btn--lg", onClick: handleSubmit, disabled: !text.trim(), style: { opacity: text.trim() ? 1 : 0.5 }, children: "Send" })] })] }));
}
//# sourceMappingURL=CommentBox.js.map