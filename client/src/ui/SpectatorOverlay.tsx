/**
 * Spectator overlay - shown when player first joins
 * Shows game info and a "Start" button to enter FPS mode
 */

import { useGameStore } from '../state/store';
import { controls } from '../game/player/controls';
import { GameMode } from '@worldify/shared';

export function SpectatorOverlay() {
  const gameMode = useGameStore((s) => s.gameMode);
  const connectionStatus = useGameStore((s) => s.connectionStatus);
  const playerCount = useGameStore((s) => s.playerCount);
  const roomId = useGameStore((s) => s.roomId);
  const setGameMode = useGameStore((s) => s.setGameMode);

  // Only show in MainMenu mode
  if (gameMode !== GameMode.MainMenu) {
    return null;
  }

  const isConnected = connectionStatus === 'connected';

  const handleStart = () => {
    // Switch to Playing mode
    setGameMode(GameMode.Playing);
    // Lock pointer for FPS controls
    controls.requestPointerLock();
  };

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-transparent to-black/30 z-50 pointer-events-none">
      {/* Game title and info */}
      <h1 className="text-5xl text-white mb-2">wrldy</h1>
      <p className="text-xl text-white opacity-80 mb-8">Rapid Survival</p>

      {/* Room info / connection status */}
      <div className="mb-8 py-4 px-8 bg-black/70 rounded-lg text-white text-center min-w-[200px]">
        {isConnected ? (
          <>
            <div className="text-sm opacity-70 mb-1">
              Room: {roomId}
            </div>
            <div className="text-lg">
              {playerCount} player{playerCount !== 1 ? 's' : ''} in game
            </div>
          </>
        ) : (
          <div className="text-lg opacity-80">Connecting...</div>
        )}
      </div>

      {/* Start button - only show when connected */}
      {isConnected && (
        <button
          onClick={handleStart}
          className="py-6 px-16 text-2xl bg-indigo-600 text-white border-none rounded-xl cursor-pointer pointer-events-auto shadow-[0_4px_20px_rgba(79,70,229,0.5)] transition-all duration-100 hover:bg-indigo-500 hover:scale-105"
        >
          ▶ Start
        </button>
      )}

      {/* Controls hint - only show when connected */}
      {isConnected && (
        <p className="mt-8 text-white opacity-70 text-base text-center max-w-md">
          WASD to move • Space to jump • Shift to sprint<br />
          1/2/3 for build tools • Click to place • Q/E to rotate
        </p>
      )}
    </div>
  );
}
