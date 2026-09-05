import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useUIStore } from "./store/ui.js";
import { useNodes, useSession, useSessions } from "./api/hooks.js";
import { navigateToSession, sessionUrl } from "./navigation.js";
import { resolveSession } from "./session-resolution.js";
import { SplitLayout } from "./components/SplitLayout.js";
import { SessionPicker } from "./components/SessionPicker.js";

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
  const paramId = new URLSearchParams(window.location.search).get("session");
  const { data, isError } = useSessions();
  const resolution = resolveSession(paramId, data?.sessions);

  // A lone session loads without a param; stamp its id into the URL so the
  // link stays shareable.
  useEffect(() => {
    if (!paramId && resolution.kind === "session") {
      window.history.replaceState(null, "", sessionUrl(resolution.sessionId));
    }
  }, [paramId, resolution]);

  if (resolution.kind === "session") {
    return (
      <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
        <StatusBar sessionId={resolution.sessionId} />
        <SplitLayout sessionId={resolution.sessionId} currentNodeId={currentNodeId} />
      </div>
    );
  }
  if (resolution.kind === "picker") return <SessionPicker sessions={resolution.sessions} />;
  if (resolution.kind === "empty" || isError) {
    return (
      <div className="session-picker" data-testid="session-empty">
        <h1 className="session-picker__title">
          {isError ? "Couldn't load sessions" : "No review sessions"}
        </h1>
        <p className="session-picker__hint">
          {isError
            ? "The review server didn't answer. Is it still running?"
            : "Ask your agent to start a code-review-walkthrough session. For example:"}
        </p>
        {!isError && <>
          <pre style={{ whiteSpace: "pre-wrap", maxWidth: 600, padding: 16, background: "var(--surface)" }}>
            Use code-review-walkthrough to review my current changes against main and open the review.
          </pre>
          <p className="session-picker__hint">Replace main with your base branch. The agent will give you a link to the planned review.</p>
          <p className="session-picker__hint">Trying it from source? Run <code>pnpm demo</code> for a small example review.</p>
        </>}
      </div>
    );
  }
  return <div className="session-picker session-picker--loading">Loading sessions…</div>;
}

/** The header reads like an instrument status line: who we are, what branch /
 *  unit is under the lens, and how far the walk has gotten. */
export function StatusBar({ sessionId }: { sessionId: string }) {
  const { data: sessionData } = useSession(sessionId);
  const { data: nodeData } = useNodes(sessionId);

  const session = sessionData?.session;
  const coverage = sessionData?.coverage;
  const units = sessionData?.units ?? [];
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
            fontSize: 19,
            letterSpacing: "-0.01em",
          }}
        >
          Trace
        </span>
        <span className="statusbar__sub" style={{ color: "var(--dim)", fontSize: 17, marginTop: 1 }}>
          code review walkthrough
        </span>
      </div>

      <Field label="branch">
        <BranchSwitcher sessionId={sessionId} currentBranch={session?.branch} />
      </Field>
      {coverage && (
        <div
          className="statusbar__field"
          data-testid="coverage-chip"
          data-warn={coverage.unassigned > 0}
          style={{ color: coverage.unassigned > 0 ? "var(--warn, #d98a2b)" : "var(--text)" }}
        >
          <span style={{ color: "var(--dim)", fontSize: 15, letterSpacing: "0.08em" }}>PLAN</span>
          <span style={{ fontSize: 17, fontVariantNumeric: "tabular-nums" }}>
            {units.length} units · {coverage.covered}/{coverage.changedTotal} changes
          </span>
        </div>
      )}
      {sessionData?.stale && (
        <div className="statusbar__field" data-testid="stale-chip" style={{ color: "var(--warn, #d98a2b)" }}>
          <span style={{ fontSize: 15 }}>⚠</span>
          <span style={{ fontSize: 16 }} title="Recreate this review session to include the current working tree. Saved review marks describe the earlier version.">repo moved since session start — recreate review</span>
        </div>
      )}
      <div style={{ flex: 1, minWidth: 8 }} />

      {total > 0 && (
        <div className="statusbar__progress">
          <span
            className="statusbar__progress-label"
            style={{ color: "var(--dim)", fontSize: 15, letterSpacing: "0.08em" }}
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
          <span style={{ fontSize: 17, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
            {reviewed}
            <span style={{ color: "var(--dim)" }}>/{total}</span>
          </span>
        </div>
      )}
    </header>
  );
}

/** Plain branch text normally; a dropdown once the server holds several
 *  sessions, so switching doesn't require hand-editing the URL. */
function BranchSwitcher({
  sessionId,
  currentBranch,
}: {
  sessionId: string;
  currentBranch?: string;
}) {
  const { data } = useSessions();
  const sessions = data?.sessions ?? [];
  if (sessions.length < 2) return <>{currentBranch ?? "—"}</>;
  return (
    <select
      className="statusbar__session-switcher"
      data-testid="session-switcher"
      value={sessionId}
      onChange={(e) => {
        if (e.target.value !== sessionId) navigateToSession(e.target.value);
      }}
    >
      {sessions.map((s) => (
        <option key={s.id} value={s.id}>
          {s.branch}
        </option>
      ))}
    </select>
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
      <span style={{ color: "var(--dim)", fontSize: 15, letterSpacing: "0.08em", flexShrink: 0 }}>
        {label.toUpperCase()}
      </span>
      <span className="statusbar__field-value" style={{ fontSize: 17, color: "var(--text)" }}>
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
