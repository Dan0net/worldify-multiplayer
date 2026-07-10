/**
 * Device-mode detection for non-React code (controls, GameCore).
 *
 * `isTouch()` is evaluated live so it stays correct if a hybrid device
 * switches input modes; callers use it to gate pointer-lock behaviour.
 */

/** True on touch/coarse-pointer devices (phones, tablets). */
export function isTouch(): boolean {
  return (
    window.matchMedia('(pointer: coarse)').matches ||
    navigator.maxTouchPoints > 0
  );
}
