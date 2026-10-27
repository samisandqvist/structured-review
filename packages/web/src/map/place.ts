// Where the reader was on a session's map: the level, the selection and the
// pan and zoom. Kept per tab, so a visit to the code returns to the same view.
import type { Selection } from "./levels.js";
import type { Transform } from "./usePanZoom.js";

export interface MapPlace {
  level: string | null;
  selection: Selection;
  transform: Transform | null;
}

const key = (sessionId: string) => `srev-map-place:${sessionId}`;

export function rememberPlace(sessionId: string, place: MapPlace): void {
  try {
    window.sessionStorage.setItem(key(sessionId), JSON.stringify(place));
  } catch {
    // Storage blocked: the map opens at its default view next time.
  }
}

export function recalledPlace(sessionId: string): MapPlace | null {
  try {
    const raw = window.sessionStorage.getItem(key(sessionId));
    return raw ? (JSON.parse(raw) as MapPlace) : null;
  } catch {
    return null;
  }
}
