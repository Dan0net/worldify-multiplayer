/**
 * React hooks for device-mode / orientation, backed by matchMedia.
 */

import { useSyncExternalStore } from 'react';
import { isTouch } from '../game/deviceMode';

/**
 * Reactive touch-primary flag. Delegates to the single `isTouch()` predicate (see deviceMode.ts)
 * and re-renders when the pointer/hover capabilities change (e.g. a 2-in-1 docking its keyboard),
 * mirroring `useIsPortrait` below.
 */
export function useIsTouch(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const coarse = window.matchMedia('(pointer: coarse)');
      const hover = window.matchMedia('(hover: none)');
      coarse.addEventListener('change', cb);
      hover.addEventListener('change', cb);
      return () => {
        coarse.removeEventListener('change', cb);
        hover.removeEventListener('change', cb);
      };
    },
    () => isTouch(),
    () => false,
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
