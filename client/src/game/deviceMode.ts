/**
 * Device-mode detection for non-React code (controls, GameCore).
 *
 * `isTouch()` is evaluated live so it stays correct if a hybrid device
 * switches input modes; callers use it to gate pointer-lock behaviour.
 */

/**
 * True only on touch-primary devices with no fine pointer (phones, tablets, and a 2-in-1 in
 * tablet mode). Deliberately does NOT use `navigator.maxTouchPoints`, which is also true on
 * touchscreen laptops — those have a fine pointer + hover and should get the desktop experience.
 * `(pointer: coarse)` reports the primary pointing device, so a laptop with a trackpad/mouse reads
 * `fine`; combined with `(hover: none)` this cleanly excludes hybrid laptops.
 */
export function isTouch(): boolean {
  return (
    window.matchMedia('(pointer: coarse)').matches &&
    window.matchMedia('(hover: none)').matches
  );
}
