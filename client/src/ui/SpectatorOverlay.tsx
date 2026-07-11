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

import { useState, useEffect } from 'react';
import { useGameStore } from '../state/store';
import { GameMode } from '@worldify/shared';
import { materialManager } from '../game/material';
import { QUALITY_LABELS, QUALITY_LEVELS } from '../game/quality/QualityPresets';
import { applyVisibilityRadius, syncQualityToStore } from '../game/quality/QualityManager';
import { getCamera } from '../game/scene/camera';
import { formatTimeOfDay } from '../game/scene/DayNightCycle';
import {
  listWorlds, getActiveWorld, setActiveWorld, createAndActivateWorld, deleteWorld,
  type WorldMeta,
} from '../game/world/WorldManager';


export function SpectatorOverlay() {
  const gameMode = useGameStore((s) => s.gameMode);
  const spawnReady = useGameStore((s) => s.spawnReady);
  const setGameMode = useGameStore((s) => s.setGameMode);
  const textureState = useGameStore((s) => s.textureState);
  const textureProgress = useGameStore((s) => s.textureProgress);
  const qualityLevel = useGameStore((s) => s.qualityLevel);
  const visibilityRadius = useGameStore((s) => s.quality.visibilityRadius);
  const fov = useGameStore((s) => s.fov);
  const renderScale = useGameStore((s) => s.renderScale);
  const setRenderScale = useGameStore((s) => s.setRenderScale);
  const timeOfDay = useGameStore((s) => s.environment.timeOfDay);
  const setTimeOfDay = useGameStore((s) => s.setTimeOfDay);
  const [hasPlayed, setHasPlayed] = useState(false);

  // World picker
  const [worlds, setWorlds] = useState<WorldMeta[]>([]);
  const [activeWorldId, setActiveWorldId] = useState<string | null>(null);
  const [worldMenuOpen, setWorldMenuOpen] = useState(false);

  const refreshWorlds = () => {
    listWorlds().then((w) => {
      setWorlds(w.slice().sort((a, b) => b.lastPlayedAt - a.lastPlayedAt));
      setActiveWorldId(getActiveWorld()?.id ?? null);
    });
  };
  useEffect(() => { refreshWorlds(); }, []);

  const selectWorld = async (id: string) => {
    await setActiveWorld(id); // triggers terrain rebuild via GameCore handler
    refreshWorlds();
    setWorldMenuOpen(false);
  };
  const newWorld = async () => {
    await createAndActivateWorld();
    refreshWorlds();
    setWorldMenuOpen(false);
  };
  const removeWorld = async (id: string) => {
    await deleteWorld(id);
    refreshWorlds();
  };

  // Shown on the home screen (Explore) — redesigned into the new home UI in a later PR.
  if (gameMode !== GameMode.Explore) return null;

  const isLoadingHD = textureState === 'loading-high';
  const hasHD = textureState === 'high';

  const play = () => { setHasPlayed(true); setGameMode(GameMode.Playing); };
  const playFullscreen = () => { document.documentElement.requestFullscreen?.(); play(); };
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
    <div className="fixed inset-0 z-50 overflow-y-auto bg-gradient-to-b from-black/20 to-black/50 pointer-events-none">
      {/* min-h-full centering wrapper: centers when it fits, scrolls from the top
          (no clipping) when the panel is taller than the viewport — e.g. mobile landscape. */}
      <div className="min-h-full flex flex-col items-center justify-center gap-4 py-4 px-6">
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
                onClick={playFullscreen}
                disabled={!spawnReady}
                aria-label="Play fullscreen"
                title="Play in fullscreen"
                className={`w-12 shrink-0 rounded-xl text-white text-xl flex items-center justify-center ${
                  spawnReady ? 'bg-white/10 hover:bg-white/20' : 'bg-white/5 text-white/40 cursor-wait'
                }`}
              >
                ⛶
              </button>
              <button
                onClick={() => setWorldMenuOpen((o) => !o)}
                aria-label="Select world"
                title="Worlds"
                className="w-10 shrink-0 rounded-xl text-white text-sm bg-white/10 hover:bg-white/20 flex items-center justify-center"
              >
                {worldMenuOpen ? '▴' : '▾'}
              </button>
            </div>

            {/* World picker */}
            {worldMenuOpen && (
              <div className="w-full rounded-xl bg-black/70 border border-white/10 p-2 flex flex-col gap-1">
                {worlds.map((w) => (
                  <div key={w.id} className="flex items-center gap-1">
                    <button
                      onClick={() => selectWorld(w.id)}
                      className={`flex-1 text-left text-sm px-2 py-1.5 rounded-lg transition-colors ${
                        w.id === activeWorldId ? 'bg-indigo-600 text-white' : 'text-white/70 hover:bg-white/10'
                      }`}
                    >
                      {w.id === activeWorldId ? '● ' : ''}{w.name}
                    </button>
                    {worlds.length > 1 && (
                      <button
                        onClick={() => removeWorld(w.id)}
                        aria-label={`Delete ${w.name}`}
                        className="w-7 h-7 shrink-0 rounded-lg text-white/40 hover:text-red-400 hover:bg-white/10 flex items-center justify-center"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                <button
                  onClick={newWorld}
                  className="text-sm px-2 py-1.5 rounded-lg text-cyan-300 hover:bg-white/10 text-left"
                >
                  ＋ New World
                </button>
              </div>
            )}
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
            {([{ label: 'Near', value: 2 }, { label: 'Close', value: 4 }, { label: 'Far', value: 6 }, { label: 'Max', value: 8 }] as const).map((opt) => (
              <button key={opt.value} onClick={() => applyVisibilityRadius(opt.value)} className={pill(visibilityRadius === opt.value)}>
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
                useGameStore.getState().setFov(val);
                const cam = getCamera();
                if (cam) { cam.fov = val; cam.updateProjectionMatrix(); }
              }}
              className="flex-1 h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer accent-indigo-500"
            />
            <span className="text-white/60 text-xs w-6 text-right">{fov}°</span>
          </div>
        </div>
        {/* Render scale — sub-native resolution for weak GPUs / 4K */}
        <div className="flex items-center justify-between gap-3">
          <span className="text-white/70 text-sm whitespace-nowrap">Resolution</span>
          <div className="flex items-center gap-2 flex-1">
            <input
              type="range" min={50} max={100} step={5} value={Math.round(renderScale * 100)}
              onChange={(e) => setRenderScale(parseInt(e.target.value, 10) / 100)}
              className="flex-1 h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer accent-indigo-500"
            />
            <span className="text-white/60 text-xs w-9 text-right">{Math.round(renderScale * 100)}%</span>
          </div>
        </div>
        {/* Time of day */}
        <div className="flex items-center justify-between gap-3">
          <span className="text-white/70 text-sm whitespace-nowrap">Time</span>
          <div className="flex items-center gap-2 flex-1">
            <input
              type="range" min={0} max={1} step={0.005} value={timeOfDay}
              onChange={(e) => setTimeOfDay(parseFloat(e.target.value))}
              className="flex-1 h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer accent-indigo-500"
            />
            <span className="text-white/60 text-xs w-9 text-right tabular-nums">{formatTimeOfDay(timeOfDay)}</span>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
