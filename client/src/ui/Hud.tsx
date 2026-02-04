
import { useGameStore } from '../state/store';
import { GameMode } from '@worldify/shared';

export function Hud() {
  const { playerCount, roomId, gameMode } = useGameStore();

  // Hide HUD when not playing
  if (gameMode !== GameMode.Playing) {
    return null;
  }

  return (
    <>
      {/* Crosshair */}
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-5 h-5 pointer-events-none z-50">
        <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-white/80 -translate-y-1/2" />
        <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-white/80 -translate-x-1/2" />
      </div>

      {/* Room info - positioned below map overlay */}
      <div className="fixed top-[230px] right-5 py-2 px-3 bg-black/60 text-white rounded-lg text-xs z-50 whitespace-nowrap">
        {roomId} • {playerCount} player{playerCount !== 1 ? 's' : ''}
      </div>
    </>
  );
}
