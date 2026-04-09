
import { useGameStore } from '../state/store';
import { NONE_PRESET_ID } from '@worldify/shared';
import { isTouchDevice } from '../game/player/isMobile';

/**
 * Get crosshair color based on build state.
 * Green = valid target, Red = invalid (too close), White = build disabled or no target.
 */
function useCrosshairColor(): string {
  const build = useGameStore((s) => s.build);
  if (build.presetId === NONE_PRESET_ID) return 'bg-white/80'; // Build disabled
  if (build.invalidReason === 'tooClose') return 'bg-red-500/90'; // Too close
  if (build.hasValidTarget) return 'bg-green-500/90'; // Valid
  return 'bg-white/80'; // No target
}

export function Hud() {
  const { playerCount, roomId } = useGameStore();
  const crosshairColor = useCrosshairColor();

  return (
    <>
      {/* Crosshair */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-5 h-5 pointer-events-none">
        <div className={`absolute top-1/2 left-0 right-0 h-0.5 -translate-y-1/2 ${crosshairColor}`} />
        <div className={`absolute left-1/2 top-0 bottom-0 w-0.5 -translate-x-1/2 ${crosshairColor}`} />
      </div>

      {/* Room info - positioned below map overlay */}
      <div className={`absolute right-3 py-1.5 px-2.5 bg-black/60 text-white rounded-lg text-xs whitespace-nowrap ${
        isTouchDevice ? 'top-[125px]' : 'top-[230px]'
      }`}>
        {roomId} • {playerCount} player{playerCount !== 1 ? 's' : ''}
      </div>
    </>
  );
}
