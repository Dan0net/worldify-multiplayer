/**
 * Spectator overlay - shown when player first joins
 * Shows game info with map background and a "Play" button to enter FPS mode
 */

import { useGameStore } from '../state/store';
import { controls } from '../game/player/controls';
import { GameMode, CHUNK_SIZE, VOXEL_SCALE, MAP_TILE_SIZE, encodeMapTileRequest } from '@worldify/shared';
import { materialManager } from '../game/material';
import { useEffect } from 'react';
import { QUALITY_LABELS, QUALITY_LEVELS } from '../game/quality/QualityPresets';
import { applyVisibilityRadius, syncQualityToStore } from '../game/quality/QualityManager';
import { storeBridge } from '../state/bridge';
import { getCamera } from '../game/scene/camera';
import { KeyInstructions, GAME_KEY_ROWS } from './KeyInstructions';
import { MapPanel } from './MapPanel';
import { getMapTileCache } from '../game/maptile/mapTileCacheSingleton';
import { sendBinary } from '../net/netClient';

// Map panel dimensions
const MAP_PANEL_W = 400;
const MAP_PANEL_H = 280;
// Fixed scale so map always fills the panel (show ~12 tiles across regardless of view distance)
const SPECTATOR_TILES_ACROSS = 12;
const SPECTATOR_MAP_SCALE = MAP_PANEL_W / (SPECTATOR_TILES_ACROSS * MAP_TILE_SIZE);
// Max tile requests to send per interval tick (throttle to avoid server flood)
const MAX_TILES_PER_TICK = 8;

export function SpectatorOverlay() {
  const gameMode = useGameStore((s) => s.gameMode);
  const connectionStatus = useGameStore((s) => s.connectionStatus);
  const playerCount = useGameStore((s) => s.playerCount);
  const spawnReady = useGameStore((s) => s.spawnReady);
  const setGameMode = useGameStore((s) => s.setGameMode);
  const textureState = useGameStore((s) => s.textureState);
  const textureProgress = useGameStore((s) => s.textureProgress);
  const qualityLevel = useGameStore((s) => s.qualityLevel);
  const visibilityRadius = useGameStore((s) => s.visibilityRadius);
  const fov = useGameStore((s) => s.fov);

  // Request tiles to fill the spectator map panel (independent of view distance)
  // Requests are throttled to MAX_TILES_PER_TICK per interval and prioritized center-outward
  useEffect(() => {
    if (gameMode !== GameMode.MainMenu || connectionStatus !== 'connected') return;
    const HALF = Math.ceil(SPECTATOR_TILES_ACROSS / 2) + 1;
    // Pre-build spiral order sorted by distance from center
    const offsets: { dx: number; dz: number }[] = [];
    for (let dz = -HALF; dz <= HALF; dz++) {
      for (let dx = -HALF; dx <= HALF; dx++) {
        offsets.push({ dx, dz });
      }
    }
    offsets.sort((a, b) => (a.dx * a.dx + a.dz * a.dz) - (b.dx * b.dx + b.dz * b.dz));

    const interval = setInterval(() => {
      const cache = getMapTileCache();
      const { x, z } = storeBridge.mapPlayerPosition;
      const tileWorldSize = CHUNK_SIZE * VOXEL_SCALE; // 8m per tile
      const centerTx = Math.floor(x / tileWorldSize);
      const centerTz = Math.floor(z / tileWorldSize);
      let sent = 0;
      for (const { dx, dz } of offsets) {
        if (sent >= MAX_TILES_PER_TICK) break;
        const tx = centerTx + dx;
        const tz = centerTz + dz;
        if (!cache.has(tx, tz)) {
          sendBinary(encodeMapTileRequest({ tx, tz }));
          sent++;
        }
      }
    }, 500);
    return () => clearInterval(interval);
  }, [gameMode, connectionStatus]);

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
    setGameMode(GameMode.Playing);
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

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-transparent to-black/40 z-50 pointer-events-none">
      {/* Logo */}
      <img src="/wrldy-logo-white.svg" alt="wrldy" className="h-28 mb-8" />

      {/* ===== Room Panel with Map Background ===== */}
      <div
        onClick={canStart ? handleStart : undefined}
        className={`group relative rounded-2xl overflow-hidden shadow-[0_0_30px_rgba(34,197,94,0.4),0_8px_32px_rgba(0,0,0,0.6)] border-2 border-indigo-600 transition-all duration-200 pointer-events-auto ${
          canStart
            ? 'cursor-pointer hover:scale-[1.03] hover:shadow-[0_0_50px_rgba(34,197,94,0.6),0_12px_48px_rgba(34,197,94,0.4)] hover:border-green-400'
            : ''
        }`}
        style={{ width: MAP_PANEL_W, height: MAP_PANEL_H }}
      >
        {/* Solid background before map loads */}
        <div className="absolute inset-0 bg-gray-900" />

        {/* Map with player markers */}
        <MapPanel
          width={MAP_PANEL_W}
          height={MAP_PANEL_H}
          scale={SPECTATOR_MAP_SCALE}
          showMarkers
          className="absolute inset-0"
        />

        {/* Top-left mode pill */}
        <div className="absolute top-3 left-3 z-10">
          <span className="bg-black/60 backdrop-blur-sm text-white text-xs font-bold tracking-widest uppercase px-3 py-1.5 rounded-lg border border-white/10">
            MULTIPLAYER CREATIVE
          </span>
        </div>

        {/* Bottom bar with player count and play button */}
        <div className="absolute bottom-0 left-0 right-0 z-10 bg-black/60 backdrop-blur-sm px-4 py-3 flex items-center justify-between">
          {isConnected ? (
            <>
              {/* Player count */}
              <div className="flex items-center gap-2 text-white">
                <svg className="w-4 h-4 text-white/70" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                </svg>
                <span className="text-sm font-medium">
                  {playerCount}<span className="text-white/50"> / 20</span>
                </span>
              </div>

              {/* Play button - lights up on panel hover */}
              <span
                className={`py-2 px-8 text-base font-semibold text-white rounded-lg shadow-[0_2px_12px_rgba(79,70,229,0.5)] transition-all duration-200 ${
                  spawnReady
                    ? 'bg-indigo-600 group-hover:bg-green-500 group-hover:shadow-[0_4px_20px_rgba(34,197,94,0.6)] group-hover:scale-110'
                    : 'bg-gray-600/80 opacity-60'
                }`}
              >
                {spawnReady ? '▶  Play' : '⏳  Loading...'}
              </span>
            </>
          ) : (
            <div className="text-white/80 text-sm w-full text-center">Connecting...</div>
          )}
        </div>
      </div>

      {/* ===== Settings Panel ===== */}
      {isConnected && (
        <div
          className="mt-3 rounded-2xl bg-black/70 border border-white/10 backdrop-blur-sm pointer-events-auto py-4 px-5 flex flex-col gap-3"
          style={{ width: MAP_PANEL_W }}
        >
          {/* Textures - two button toggle */}
          <div className="flex items-center justify-between">
            <span className="text-white/70 text-sm">Textures</span>
            <div className="flex gap-1" style={{ width: 268 }}>
              <button
                onClick={() => { if (hasHD) handleToggleHD(); }}
                disabled={textureState === 'loading-low'}
                className={`py-1 flex-1 text-xs rounded-lg transition-all duration-100 cursor-pointer text-center ${
                  !hasHD && !isLoadingHD
                    ? 'text-white bg-indigo-600'
                    : 'text-white/50 bg-white/10 hover:bg-white/20'
                }`}
              >
                {textureState === 'loading-low' ? `Downloading ${Math.round(textureProgress * 100)}%` : 'Low'}
              </button>
              <button
                onClick={() => { if (!hasHD) handleToggleHD(); }}
                disabled={isLoadingHD}
                className={`py-1 flex-1 text-xs rounded-lg transition-all duration-100 cursor-pointer text-center ${
                  hasHD
                    ? 'text-white bg-indigo-600'
                    : isLoadingHD
                      ? 'text-yellow-400 bg-yellow-900/30'
                      : 'text-white/50 bg-white/10 hover:bg-white/20'
                }`}
              >
                {isLoadingHD ? `Downloading ${Math.round(textureProgress * 100)}%` : hasHD ? 'High' : 'High (~540MB)'}
              </button>
            </div>
          </div>

          {/* Quality preset */}
          <div className="flex items-center justify-between">
            <span className="text-white/70 text-sm">Quality</span>
            <div className="flex gap-1" style={{ width: 268 }}>
              {QUALITY_LEVELS.map((level) => (
                <button
                  key={level}
                  onClick={() => syncQualityToStore(level, visibilityRadius)}
                  className={`py-1 flex-1 text-xs rounded-lg transition-all duration-100 cursor-pointer text-center ${
                    qualityLevel === level
                      ? 'text-white bg-indigo-600'
                      : 'text-white/50 bg-white/10 hover:bg-white/20'
                  }`}
                >
                  {QUALITY_LABELS[level]}
                </button>
              ))}
            </div>
          </div>

          {/* View Distance - 4 button toggle */}
          <div className="flex items-center justify-between">
            <span className="text-white/70 text-sm whitespace-nowrap">View Dist</span>
            <div className="flex gap-1" style={{ width: 268 }}>
              {([{ label: 'Near', value: 4 }, { label: 'Close', value: 8 }, { label: 'Far', value: 10 }, { label: 'Max', value: 12 }] as const).map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => {
                    storeBridge.setVisibilityRadius(opt.value);
                    applyVisibilityRadius(opt.value);
                  }}
                  className={`py-1 flex-1 text-xs rounded-lg transition-all duration-100 cursor-pointer text-center ${
                    visibilityRadius === opt.value
                      ? 'text-white bg-indigo-600'
                      : 'text-white/50 bg-white/10 hover:bg-white/20'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* FoV slider */}
          <div className="flex items-center justify-between">
            <span className="text-white/70 text-sm whitespace-nowrap">Field of View</span>
            <div className="flex items-center gap-2" style={{ width: 268 }}>
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
                className="flex-1 h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer accent-indigo-500"
              />
              <span className="text-white/60 text-xs w-6 text-right">{fov}°</span>
            </div>
          </div>
        </div>
      )}

      {/* Controls hint at bottom */}
      {isConnected && (
        <div className="fixed bottom-4 left-0 right-0 flex justify-center pointer-events-none">
          <KeyInstructions rows={GAME_KEY_ROWS} />
        </div>
      )}
    </div>
  );
}
