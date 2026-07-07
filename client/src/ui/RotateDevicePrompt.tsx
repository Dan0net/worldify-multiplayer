/**
 * RotateDevicePrompt - full-screen overlay shown on touch devices held in
 * portrait. The game UI is landscape-first, so we ask the user to rotate.
 */

import { useIsTouch, useIsPortrait } from './useDeviceMode';

export function RotateDevicePrompt() {
  const isTouch = useIsTouch();
  const isPortrait = useIsPortrait();

  if (!isTouch || !isPortrait) return null;

  return (
    <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-4 bg-black/95 text-white text-center px-8 pointer-events-auto">
      <div className="text-5xl animate-pulse">⟳</div>
      <div className="text-lg font-semibold">Rotate your device</div>
      <div className="text-sm text-white/60">This game is best played in landscape.</div>
    </div>
  );
}
