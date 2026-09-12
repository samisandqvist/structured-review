import type { ReviewSession } from "../api/client.js";
import { navigateToSession } from "../navigation.js";

/** Full-page list shown when several sessions exist and none is in the URL. */
export function SessionPicker({ sessions }: { sessions: ReviewSession[] }) {
  return (
    <div className="session-picker" data-testid="session-picker">
      <h1 className="session-picker__title">Pick a review session</h1>
      <p className="session-picker__hint">
        Several sessions are open on this server. Selecting one navigates to a shareable link.
      </p>
      <ul className="session-picker__list">
        {sessions.map((s) => (
          <li key={s.id}>
            <button className="session-picker__row" onClick={() => navigateToSession(s.id)}>
              <span className="session-picker__branch">{s.branch}</span>
              <span className="session-picker__base">← {s.baseRef}</span>
              <span className="session-picker__status" data-status={s.status}>
                {s.status}
              </span>
              <span className="session-picker__date">
                {new Date(s.createdAt).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
