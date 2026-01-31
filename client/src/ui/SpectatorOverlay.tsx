/**
 * Spectator overlay - shown when player first joins
 * Shows game info and a "Start" button to enter FPS mode
 */

import { useGameStore } from '../state/store';
import { controls } from '../game/player/controls';
import { GameMode } from '@worldify/shared';
import { materialManager } from '../game/material';
import { useState, useEffect } from 'react';

export function SpectatorOverlay() {
  const gameMode = useGameStore((s) => s.gameMode);
  const connectionStatus = useGameStore((s) => s.connectionStatus);
  const playerCount = useGameStore((s) => s.playerCount);
  const roomId = useGameStore((s) => s.roomId);
  const spawnReady = useGameStore((s) => s.spawnReady);
  const setGameMode = useGameStore((s) => s.setGameMode);
  const textureState = useGameStore((s) => s.textureState);
  
  const [hdCached, setHdCached] = useState<boolean | null>(null);

  // Check if HD textures are cached on mount
  useEffect(() => {
    materialManager.checkHighResAvailable().then(setHdCached);
  }, []);

  // Only show in MainMenu mode
  if (gameMode !== GameMode.MainMenu) {
    return null;
  }

  const isConnected = connectionStatus === 'connected';
  const canStart = isConnected && spawnReady;
  const isLoadingTextures = textureState === 'loading-low' || textureState === 'loading-high';
  const hasHD = textureState === 'high';
  // Only show HD button if: we have low textures, HD is not cached, and not already loading
  const showHDButton = textureState === 'low' && hdCached === false;

  const handleStart = () => {
    if (!canStart) return;
    // Switch to Playing mode
    setGameMode(GameMode.Playing);
    // Lock pointer for FPS controls
    controls.requestPointerLock();
  };

  const handleDownloadHD = () => {
    if (isLoadingTextures || hasHD) return;
    materialManager.upgradeToHighResolution();
  };

  const handleToggleHD = () => {
    if (isLoadingTextures) return;
    if (hasHD) {
      materialManager.downgradeToLowResolution();
    } else {
      materialManager.upgradeToHighResolution();
    }
  };

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-transparent to-black/30 z-50 pointer-events-none">
      {/* Game title and info */}
      <img src="/wrldy-logo-white.svg" alt="wrldy" className="h-16 mb-4" />

      {/* Room info / connection status */}
      <div className="mb-8 py-4 px-8 bg-black/70 rounded-lg text-white text-center whitespace-nowrap">
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

      {/* HD Textures download button - only show if low-res and HD not cached */}
      {isConnected && showHDButton && (
        <button
          onClick={handleDownloadHD}
          className="mt-4 py-3 px-8 text-sm text-white border border-white/30 rounded-lg pointer-events-auto transition-all duration-100 bg-white/10 hover:bg-white/20 cursor-pointer"
        >
          ⬇ Download HD Textures (~540 MB)
        </button>
      )}
      
      {/* HD Textures toggle - show when HD is active, cached, or loading */}
      {isConnected && (hasHD || (textureState === 'low' && hdCached) || isLoadingTextures) && (
        <button
          onClick={handleToggleHD}
          disabled={isLoadingTextures}
          className={`mt-4 py-2 px-4 text-xs rounded pointer-events-auto transition-all duration-100 flex items-center gap-2 w-40 ${
            isLoadingTextures
              ? 'text-yellow-400 bg-yellow-900/30 cursor-wait'
              : hasHD
                ? 'text-green-400 bg-green-900/30 hover:bg-green-900/50 cursor-pointer'
                : 'text-gray-400 bg-gray-900/30 hover:bg-gray-900/50 cursor-pointer'
          }`}
        >
          {isLoadingTextures ? (
            <>
              <span className="inline-block w-9 h-5 rounded-full relative bg-yellow-600/50">
                <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow flex items-center justify-center">
                  <svg className="animate-spin w-3 h-3 text-yellow-600" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                </span>
              </span>
              <span>Loading...</span>
            </>
          ) : (
            <>
              <span 
                className={`inline-block w-9 h-5 rounded-full relative transition-colors ${
                  hasHD ? 'bg-green-600' : 'bg-gray-600'
                }`}
              >
                <span 
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${
                    hasHD ? 'translate-x-4' : 'translate-x-0'
                  }`} 
                />
              </span>
              <span>HD Textures</span>
            </>
          )}
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
