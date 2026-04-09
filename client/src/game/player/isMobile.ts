/**
 * Mobile/touch device detection.
 * Checks for touch capability and small screen size.
 */

/** Whether the device supports touch input (cached at load time) */
export const isTouchDevice: boolean =
  typeof window !== 'undefined' &&
  ('ontouchstart' in window || navigator.maxTouchPoints > 0);

/** Whether this looks like a mobile/tablet form factor */
export const isMobileDevice: boolean =
  isTouchDevice && (window.innerWidth <= 1024 || window.innerHeight <= 600);
