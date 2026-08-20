export function sessionUrl(id: string): string {
  return `/?session=${encodeURIComponent(id)}`;
}

/** Full navigation on purpose: query state, stores, and caches all reset. */
export function navigateToSession(id: string): void {
  window.location.assign(sessionUrl(id));
}
