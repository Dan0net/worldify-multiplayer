/**
 * Home / pause menu overlay.
 *
 * The local world boots on page load (App), so this overlay sits over the
 * rotating-camera world. It shows:
 * - Multiplayer (disabled while the server is offline) + Play Local + Fullscreen.
 * - Play Local is gated on spawnReady, so the player only spawns into a world
 *   whose terrain + colliders are already generated (no fall-through).
 * - After playing, returning here (pause) shows Resume.
 * - Quality / textures / view-distance / FoV settings.
 *
 * Compact + scrollable so it fits portrait and landscape.
 */

import { useState } from 'react';
import { useGameStore } from '../state/store';
import { GameMode } from '@worldify/shared';
import { materialManager } from '../game/material';
import { QUALITY_LABELS, QUALITY_LEVELS } from '../game/quality/QualityPresets';
import { applyVisibilityRadius, syncQualityToStore } from '../game/quality/QualityManager';
import { storeBridge } from '../state/bridge';
import { getCamera } from '../game/scene/camera';

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
  } else {
    document.documentElement.requestFullscreen?.();
  }
}

export function SpectatorOverlay() {
  const gameMode = useGameStore((s) => s.gameMode);
  const spawnReady = useGameStore((s) => s.spawnReady);
  const setGameMode = useGameStore((s) => s.setGameMode);
  const textureState = useGameStore((s) => s.textureState);
  const textureProgress = useGameStore((s) => s.textureProgress);
  const qualityLevel = useGameStore((s) => s.qualityLevel);
  const visibilityRadius = useGameStore((s) => s.visibilityRadius);
  const fov = useGameStore((s) => s.fov);
  const [hasPlayed, setHasPlayed] = useState(false);

  if (gameMode !== GameMode.MainMenu) return null;

  const isLoadingHD = textureState === 'loading-high';
  const hasHD = textureState === 'high';

  const play = () => { setHasPlayed(true); setGameMode(GameMode.Playing); };
  const toggleHD = () => {
    if (isLoadingHD) return;
    if (hasHD) materialManager.downgradeToLowResolution();
    else materialManager.upgradeToHighResolution();
  };

  const pill = (active: boolean) =>
    `py-1 flex-1 text-xs rounded-lg transition-colors text-center cursor-pointer ${
      active ? 'text-white bg-indigo-600' : 'text-white/50 bg-white/10 hover:bg-white/20'
    }`;

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 overflow-y-auto py-4 px-6 bg-gradient-to-b from-black/20 to-black/50 pointer-events-none">
      <img src="/wrldy-logo-white.svg" alt="wrldy" className="h-14 pointer-events-none" />

      {/* Primary actions */}
      <div className="flex flex-col items-center gap-3 w-full max-w-xs pointer-events-auto">
        {hasPlayed ? (
          <button onClick={() => setGameMode(GameMode.Playing)} className="w-full py-3 rounded-xl text-base font-semibold bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-400 text-white shadow-lg transition-colors">
            ▶  Resume
          </button>
        ) : (
          <>
            <button
              disabled
              title="Multiplayer server is offline"
              className="w-full py-3 rounded-xl text-base font-semibold bg-white/10 text-white/40 border border-white/10 cursor-not-allowed"
            >
              Multiplayer <span className="text-xs">(offline)</span>
            </button>
            <div className="flex w-full gap-2">
              <button
                onClick={play}
                disabled={!spawnReady}
                className={`flex-1 py-3 rounded-xl text-base font-semibold text-white shadow-lg transition-colors ${
                  spawnReady ? 'bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-400' : 'bg-gray-600/70 cursor-wait'
                }`}
              >
                {spawnReady ? '▶  Play Local' : '⏳  Generating…'}
              </button>
              <button
                onClick={toggleFullscreen}
                aria-label="Toggle fullscreen"
                className="w-12 shrink-0 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xl flex items-center justify-center"
              >
                ⛶
              </button>
            </div>
          </>
        )}
      </div>

      {/* Settings */}
      <div className="w-full max-w-xs rounded-2xl bg-black/70 border border-white/10 py-3 px-4 flex flex-col gap-2.5 pointer-events-auto">
        {/* Textures */}
        <div className="flex items-center justify-between gap-3">
          <span className="text-white/70 text-sm">Textures</span>
          <div className="flex gap-1 flex-1">
            <button onClick={() => { if (hasHD) toggleHD(); }} disabled={textureState === 'loading-low'} className={pill(!hasHD && !isLoadingHD)}>
              {textureState === 'loading-low' ? `${Math.round(textureProgress * 100)}%` : 'Low'}
            </button>
            <button onClick={() => { if (!hasHD) toggleHD(); }} disabled={isLoadingHD} className={pill(hasHD)}>
              {isLoadingHD ? `${Math.round(textureProgress * 100)}%` : hasHD ? 'High' : 'High (HD)'}
            </button>
          </div>
        </div>
        {/* Quality */}
        <div className="flex items-center justify-between gap-3">
          <span className="text-white/70 text-sm">Quality</span>
          <div className="flex gap-1 flex-1">
            {QUALITY_LEVELS.map((level) => (
              <button key={level} onClick={() => syncQualityToStore(level, visibilityRadius)} className={pill(qualityLevel === level)}>
                {QUALITY_LABELS[level]}
              </button>
            ))}
          </div>
        </div>
        {/* View distance */}
        <div className="flex items-center justify-between gap-3">
          <span className="text-white/70 text-sm whitespace-nowrap">View</span>
          <div className="flex gap-1 flex-1">
            {([{ label: 'Near', value: 4 }, { label: 'Close', value: 8 }, { label: 'Far', value: 10 }, { label: 'Max', value: 12 }] as const).map((opt) => (
              <button key={opt.value} onClick={() => { storeBridge.setVisibilityRadius(opt.value); applyVisibilityRadius(opt.value); }} className={pill(visibilityRadius === opt.value)}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        {/* FoV */}
        <div className="flex items-center justify-between gap-3">
          <span className="text-white/70 text-sm whitespace-nowrap">FoV</span>
          <div className="flex items-center gap-2 flex-1">
            <input
              type="range" min={75} max={120} step={1} value={fov}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                storeBridge.setFov(val);
                const cam = getCamera();
                if (cam) { cam.fov = val; cam.updateProjectionMatrix(); }
              }}
              className="flex-1 h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer accent-indigo-500"
            />
            <span className="text-white/60 text-xs w-6 text-right">{fov}°</span>
          </div>
        </div>
      </div>
    </div>
  );
}
