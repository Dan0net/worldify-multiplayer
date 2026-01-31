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
  const spawnReady = useGameStore((s) => s.spawnReady);
  const setGameMode = useGameStore((s) => s.setGameMode);

  // Only show in MainMenu mode
  if (gameMode !== GameMode.MainMenu) {
    return null;
  }

  const isConnected = connectionStatus === 'connected';
  const canStart = isConnected && spawnReady;

  const handleStart = () => {
    if (!canStart) return;
    // Switch to Playing mode
    setGameMode(GameMode.Playing);
    // Lock pointer for FPS controls
    controls.requestPointerLock();
  };

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-transparent to-black/30 z-50 pointer-events-none">
      {/* Game title and info */}
      <img src="/wrldy-logo-white.svg" alt="wrldy" className="h-16 mb-4" />

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
            {!spawnReady && (
              <div className="text-sm text-yellow-400 mt-2">
                Loading terrain...
              </div>
            )}
          </>
        ) : (
          <div className="text-lg opacity-80">Connecting...</div>
        )}
      </div>

      {/* Start button - only show when connected, enable when spawn ready */}
      {isConnected && (
        <button
          onClick={handleStart}
          disabled={!spawnReady}
          className={`py-6 px-16 text-2xl text-white border-none rounded-xl pointer-events-auto shadow-[0_4px_20px_rgba(79,70,229,0.5)] transition-all duration-100 ${
            spawnReady
              ? 'bg-indigo-600 cursor-pointer hover:bg-indigo-500 hover:scale-105'
              : 'bg-gray-600 cursor-not-allowed opacity-50'
          }`}
        >
          {spawnReady ? '▶ Start' : '⏳ Loading...'}
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
