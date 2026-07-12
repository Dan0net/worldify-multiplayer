
import { useGameStore } from '../state/store';
import { useIsTouch } from './useDeviceMode';

/**
 * Get crosshair color based on build state.
 * Green = valid target, Red = invalid (too close), White = build disabled or no target.
 */
function useCrosshairColor(): string {
  const build = useGameStore((s) => s.build);
  if (!build.buildMode) return 'bg-white/80'; // Build disabled
  if (build.invalidReason === 'tooClose') return 'bg-red-500/90'; // Too close
  if (build.hasValidTarget) return 'bg-green-500/90'; // Valid
  return 'bg-white/80'; // No target
}

export function Hud() {
  // Field selectors (not a bare `useGameStore()`), so the HUD only re-renders when
  // these specific values change — not on every per-frame store write (voxel stats etc.).
  const playerCount = useGameStore((s) => s.playerCount);
  const roomId = useGameStore((s) => s.roomId);
  const useServerChunks = useGameStore((s) => s.useServerChunks);
  const crosshairColor = useCrosshairColor();
  const isTouch = useIsTouch();

  return (
    <>
      {/* Crosshair (desktop; on touch the draggable reticle in MobileControls takes over) */}
      {!isTouch && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-5 h-5 pointer-events-none">
          <div className={`absolute top-1/2 left-0 right-0 h-0.5 -translate-y-1/2 ${crosshairColor}`} />
          <div className={`absolute left-1/2 top-0 bottom-0 w-0.5 -translate-x-1/2 ${crosshairColor}`} />
        </div>
      )}

      {/* Room / player count — multiplayer only (hidden in local play) */}
      {useServerChunks && (
        <div className="absolute top-2 left-2 md:top-[230px] md:left-auto md:right-5 py-1.5 px-2.5 md:py-2 md:px-3 bg-black/60 text-white rounded-lg text-[10px] md:text-xs whitespace-nowrap">
          {roomId} • {playerCount} player{playerCount !== 1 ? 's' : ''}
        </div>
      )}
    </>
  );
}
