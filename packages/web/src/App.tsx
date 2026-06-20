import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useUIStore } from "./store/ui.js";
import { useNodes, useSession } from "./api/hooks.js";
import { SplitLayout } from "./components/SplitLayout.js";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 1000, refetchOnWindowFocus: false } },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ReviewShell />
    </QueryClientProvider>
  );
}

function ReviewShell() {
  const currentNodeId = useUIStore((s) => s.currentNodeId);
  const sessionId =
    new URLSearchParams(window.location.search).get("session") ?? "placeholder";
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <StatusBar sessionId={sessionId} />
      <SplitLayout sessionId={sessionId} currentNodeId={currentNodeId} />
    </div>
  );
}

/** The header reads like an instrument status line: who we are, what branch /
 *  unit is under the lens, and how far the walk has gotten. */
function StatusBar({ sessionId }: { sessionId: string }) {
  const { data: sessionData } = useSession(sessionId);
  const { data: nodeData } = useNodes(sessionId);

  const session = sessionData?.session;
  const unit = sessionData?.units?.[0];
  const nodes = nodeData?.nodes ?? [];
  const changed = nodes.filter((n) => n.changeStatus === "changed");
  const reviewed = changed.filter((n) => n.reviewStatus !== "unreviewed").length;
  const total = changed.length;
  const pct = total > 0 ? Math.round((reviewed / total) * 100) : 0;

  return (
    <header className="statusbar">
      <div className="statusbar__brand">
        <TraceMark />
        <span
          style={{
            fontFamily: "var(--display)",
            fontWeight: 700,
            fontSize: 17,
            letterSpacing: "-0.01em",
          }}
        >
          Trace
        </span>
        <span className="statusbar__sub" style={{ color: "var(--dim)", fontSize: 15, marginTop: 1 }}>
          code review walkthrough
        </span>
      </div>

      <div
        className="statusbar__rule"
        style={{ width: 1, height: 22, background: "var(--line)" }}
      />

      <Field label="branch">{session?.branch ?? "—"}</Field>
      {unit && (
        <Field label="unit" className="statusbar__field--unit">
          {unit.label}
        </Field>
      )}

      <div style={{ flex: 1, minWidth: 8 }} />

      {total > 0 && (
        <div className="statusbar__progress">
          <span
            className="statusbar__progress-label"
            style={{ color: "var(--dim)", fontSize: 13, letterSpacing: "0.08em" }}
          >
            REVIEWED
          </span>
          <div
            className="statusbar__meter"
            style={{
              height: 6,
              borderRadius: 3,
              background: "var(--surface-2)",
              overflow: "hidden",
              border: "1px solid var(--line)",
            }}
          >
            <div
              style={{
                width: `${pct}%`,
                height: "100%",
                background: "var(--trace)",
                boxShadow: "0 0 8px var(--trace-glow)",
                transition: "width 0.3s ease",
              }}
            />
          </div>
          <span style={{ fontSize: 15, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
            {reviewed}
            <span style={{ color: "var(--dim)" }}>/{total}</span>
          </span>
        </div>
      )}
    </header>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`statusbar__field${className ? ` ${className}` : ""}`}>
      <span style={{ color: "var(--dim)", fontSize: 13, letterSpacing: "0.08em", flexShrink: 0 }}>
        {label.toUpperCase()}
      </span>
      <span className="statusbar__field-value" style={{ fontSize: 15, color: "var(--text)" }}>
        {children}
      </span>
    </div>
  );
}

/** A small downward-tracing glyph — a signal stepping through call depth. */
function TraceMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M3 3.5h4M3 9h8M3 14.5h5"
        stroke="var(--trace)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="14" cy="9" r="2" fill="var(--trace)" />
      <circle cx="13" cy="3.5" r="1.4" fill="var(--dim)" />
      <circle cx="10.5" cy="14.5" r="1.4" fill="var(--dim)" />
    </svg>
  );
}
