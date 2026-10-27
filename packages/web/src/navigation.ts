export function sessionUrl(id: string): string {
  return `/?session=${encodeURIComponent(id)}`;
}

/** Full navigation on purpose: query state, stores, and caches all reset. */
export function navigateToSession(id: string): void {
  window.location.assign(sessionUrl(id));
}

/** The component map page; `level` is a component id or "system". */
export function mapUrl(sessionId: string, level?: string): string {
  return `${sessionUrl(sessionId)}&view=map${level ? `&level=${encodeURIComponent(level)}` : ""}`;
}
