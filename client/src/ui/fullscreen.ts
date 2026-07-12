/**
 * Fullscreen helpers.
 *
 * Play enters fullscreen on mobile (immersive); returning to the home screen
 * (the X menu button) leaves it. Both no-op where the API is unavailable.
 */

export function exitFullscreenIfActive(): void {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => { /* ignore */ });
}

export function requestFullscreen(): void {
  document.documentElement.requestFullscreen?.().catch(() => { /* ignore */ });
}
