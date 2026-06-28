import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
const STATUS_STYLES = {
    unreviewed: { color: "var(--led-unreviewed)", label: "unreviewed" },
    "reviewed-clean": { color: "var(--led-clean)", label: "reviewed" },
    "reviewed-commented": { color: "var(--led-commented)", label: "commented" },
    "reviewed-elsewhere": { color: "var(--led-elsewhere)", label: "seen elsewhere" },
};
export function NodeBadge({ status }) {
    const style = STATUS_STYLES[status];
    return (_jsxs("span", { style: {
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            letterSpacing: "0.03em",
            color: "var(--dim)",
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: 999,
            padding: "2px 9px 2px 7px",
        }, children: [_jsx("span", { style: {
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: style.color,
                    boxShadow: `0 0 5px ${style.color}`,
                } }), style.label] }));
}
//# sourceMappingURL=NodeBadge.js.map