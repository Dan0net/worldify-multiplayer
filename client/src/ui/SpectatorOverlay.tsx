/**
 * Spectator overlay - shown when player first joins
 * Shows game info and a "Start" button to enter FPS mode
 */

import { useGameStore } from '../state/store';
import { controls } from '../game/player/controls';
import { GameMode } from '@worldify/shared';
import { materialManager } from '../game/material';
import { useState, useEffect } from 'react';
import { QUALITY_LABELS, QUALITY_LEVELS } from '../game/quality/QualityPresets';
import { applyVisibilityRadius, syncQualityToStore } from '../game/quality/QualityManager';
import { storeBridge } from '../state/bridge';
import { getCamera } from '../game/scene/camera';

export function SpectatorOverlay() {
  const gameMode = useGameStore((s) => s.gameMode);
  const connectionStatus = useGameStore((s) => s.connectionStatus);
  const playerCount = useGameStore((s) => s.playerCount);
  const roomId = useGameStore((s) => s.roomId);
  const spawnReady = useGameStore((s) => s.spawnReady);
  const setGameMode = useGameStore((s) => s.setGameMode);
  const textureState = useGameStore((s) => s.textureState);
  const textureProgress = useGameStore((s) => s.textureProgress);
  const qualityLevel = useGameStore((s) => s.qualityLevel);
  const visibilityRadius = useGameStore((s) => s.visibilityRadius);
  const fov = useGameStore((s) => s.fov);
  
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
  const isLoadingHD = textureState === 'loading-high';
  const hasHD = textureState === 'high';

  const handleStart = () => {
    if (!canStart) return;
    // Switch to Playing mode
    setGameMode(GameMode.Playing);
    // Lock pointer for FPS controls
    controls.requestPointerLock();
  };

  const handleToggleHD = () => {
    if (isLoadingHD) return;
    if (hasHD) {
      materialManager.downgradeToLowResolution();
    } else {
      materialManager.upgradeToHighResolution();
    }
  };

  // Determine the label text for HD toggle
  const getHDLabel = () => {
    const progress = Math.round(textureProgress * 100);
    if (isLoadingHD) {
      // Check if loading from cache or downloading
      if (hdCached) {
        return `Loading from cache ${progress}%`;
      }
      return `Downloading ${progress}%`;
    }
    if (textureState === 'loading-low') {
      return `Loading ${progress}%`;
    }
    if (hasHD) {
      return 'HD textures';
    }
    return 'HD textures (~540MB)';
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

      {/* HD Textures toggle - always show when connected */}
      {isConnected && (
        <button
          onClick={handleToggleHD}
          disabled={isLoadingHD || textureState === 'loading-low'}
          className={`mt-4 py-2 px-4 text-xs rounded pointer-events-auto transition-all duration-100 flex items-center gap-2 ${
            isLoadingHD || textureState === 'loading-low'
              ? 'text-yellow-400 bg-yellow-900/30 cursor-wait'
              : hasHD
                ? 'text-green-400 bg-green-900/30 hover:bg-green-900/50 cursor-pointer'
                : 'text-gray-400 bg-gray-900/30 hover:bg-gray-900/50 cursor-pointer'
          }`}
        >
          <span 
            className={`inline-block w-9 h-5 rounded-full relative transition-colors ${
              isLoadingHD || textureState === 'loading-low'
                ? 'bg-yellow-600/50' 
                : hasHD 
                  ? 'bg-green-600' 
                  : 'bg-gray-600'
            }`}
          >
            <span 
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 flex items-center justify-center ${
                hasHD || isLoadingHD ? 'translate-x-4' : 'translate-x-0'
              }`}
            >
              {(isLoadingHD || textureState === 'loading-low') && (
                <svg className="animate-spin w-3 h-3 text-yellow-600" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              )}
            </span>
          </span>
          <span>{getHDLabel()}</span>
        </button>
      )}

      {/* Quality preset select */}
      {isConnected && (
        <div className="mt-3 flex items-center gap-2 pointer-events-auto">
          <span className="text-white text-xs opacity-70">Quality:</span>
          <div className="flex gap-1">
            {QUALITY_LEVELS.map((level) => (
              <button
                key={level}
                onClick={() => {
                  syncQualityToStore(level, visibilityRadius);
                }}
                className={`py-1 px-3 text-xs rounded transition-all duration-100 ${
                  qualityLevel === level
                    ? 'text-white bg-indigo-600'
                    : 'text-gray-400 bg-gray-900/30 hover:bg-gray-900/50'
                }`}
              >
                {QUALITY_LABELS[level]}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Visibility radius slider */}
      {isConnected && (
        <div className="mt-2 flex items-center gap-2 pointer-events-auto">
          <span className="text-white text-xs opacity-70 whitespace-nowrap">View Dist:</span>
          <input
            type="range"
            min={2}
            max={10}
            step={1}
            value={visibilityRadius}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              storeBridge.setVisibilityRadius(val);
              applyVisibilityRadius(val);
            }}
            className="w-24 h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
          />
          <span className="text-white text-xs opacity-70">{visibilityRadius}</span>
        </div>
      )}

      {/* FoV slider */}
      {isConnected && (
        <div className="mt-2 flex items-center gap-2 pointer-events-auto">
          <span className="text-white text-xs opacity-70 whitespace-nowrap">FoV:</span>
          <input
            type="range"
            min={75}
            max={120}
            step={1}
            value={fov}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              storeBridge.setFov(val);
              const cam = getCamera();
              if (cam) {
                cam.fov = val;
                cam.updateProjectionMatrix();
              }
            }}
            className="w-24 h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
          />
          <span className="text-white text-xs opacity-70">{fov}°</span>
        </div>
      )}

      {/* Controls hint - only show when connected */}
      {isConnected && (
        <p className="mt-8 text-white opacity-70 text-base text-center max-w-md">
          WASD to move • Space to jump • Shift to sprint<br />
          1/2/3 for build tools • Click to place • Q/E to rotate<br />
          M for map
        </p>
      )}
    </div>
  );
}
