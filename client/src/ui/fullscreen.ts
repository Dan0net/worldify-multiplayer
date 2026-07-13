/**
 * Fullscreen helpers.
 *
 * Play enters fullscreen on mobile (immersive); returning to the home screen
 * (the X menu button) leaves it. Both no-op where the API is unavailable.
 */

export function exitFullscreenIfActive(): void {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => { /* ignore */ });
}

/**
 * Enter fullscreen. Returns a promise that resolves once the browser has entered
 * (or immediately if unavailable/failed), so callers can sequence work after it —
 * e.g. mobile waits for fullscreen before starting the play-mode camera transition.
 */
export function requestFullscreen(): Promise<void> {
  const el = document.documentElement;
  if (!el.requestFullscreen) return Promise.resolve();
  return el.requestFullscreen().catch(() => { /* ignore */ });
}
