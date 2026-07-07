/**
 * React hooks for device-mode / orientation, backed by matchMedia.
 */

import { useSyncExternalStore } from 'react';

/** True on touch/coarse-pointer devices. */
export function useIsTouch(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0)
  );
}

/** Reactive portrait/landscape flag (re-renders on orientation change). */
export function useIsPortrait(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia('(orientation: portrait)');
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => window.matchMedia('(orientation: portrait)').matches,
    () => false,
  );
}
