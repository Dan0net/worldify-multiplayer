/**
 * ExploreOverlay — the home screen shown over the free explore camera.
 *
 * No dimming (world renders full brightness). wrldy logo top-center (clear of the
 * FPS/debug counter). Two bottom buttons — Worlds and Settings — each opening a
 * panel. Play is entered via the marker-tracking Play button (below), not a menu
 * button: tap the ground to place a spawn marker, then tap Play to spawn there.
 */

import { useState, useEffect, useRef } from 'react';
import { useGameStore } from '../state/store';
import { GameMode } from '@worldify/shared';
import { materialManager } from '../game/material';
import { QUALITY_LABELS, QUALITY_LEVELS } from '../game/quality/QualityPresets';
import { applyVisibilityRadius, syncQualityToStore } from '../game/quality/QualityManager';
import { getCamera } from '../game/scene/camera';
import { formatTimeOfDay } from '../game/scene/DayNightCycle';
import { isTouch } from '../game/deviceMode';
import { isMarkerPlaced, getMarkerTop, armMarkerSpawn } from '../game/spawn/SpawnMarker';
import {
  listWorlds, getActiveWorld, setActiveWorld, createAndActivateWorld, deleteWorld,
  type WorldMeta,
} from '../game/world/WorldManager';

/** Play button that tracks the top of the spawn marker in screen space. */
function MarkerPlayButton() {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let raf = 0;
    const v = { x: 0, y: 0, z: 0 } as { x: number; y: number; z: number };
    const tick = () => {
      const btn = ref.current;
      const cam = getCamera();
      if (btn && cam && isMarkerPlaced()) {
        const p = getMarkerTop().clone().project(cam);
        v.x = p.x; v.y = p.y; v.z = p.z;
        const onScreen = v.z < 1 && v.x >= -1 && v.x <= 1 && v.y >= -1 && v.y <= 1;
        if (onScreen) {
          btn.style.display = '';
          btn.style.left = `${(v.x * 0.5 + 0.5) * window.innerWidth}px`;
          btn.style.top = `${(-v.y * 0.5 + 0.5) * window.innerHeight}px`;
        } else {
          btn.style.display = 'none';
        }
      } else if (btn) {
        btn.style.display = 'none';
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const play = () => {
    armMarkerSpawn();
    if (isTouch()) {
      const fs = document.documentElement.requestFullscreen?.();
      fs?.catch(() => { /* ignore */ });
    }
    useGameStore.getState().setGameMode(GameMode.Playing);
  };

  return (
    <button
      ref={ref}
      onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); play(); }}
      style={{ position: 'fixed', transform: 'translate(-50%,-115%)', display: 'none' }}
      className="pointer-events-auto px-8 py-4 rounded-full text-2xl font-bold bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-400 text-white shadow-xl border border-white/25 whitespace-nowrap"
      aria-label="Play from here"
    >
      ▶ Play
    </button>
  );
}

export function ExploreOverlay() {
  const gameMode = useGameStore((s) => s.gameMode);
  const textureState = useGameStore((s) => s.textureState);
  const textureProgress = useGameStore((s) => s.textureProgress);
  const qualityLevel = useGameStore((s) => s.qualityLevel);
  const visibilityRadius = useGameStore((s) => s.quality.visibilityRadius);
  const fov = useGameStore((s) => s.fov);
  const renderScale = useGameStore((s) => s.renderScale);
  const setRenderScale = useGameStore((s) => s.setRenderScale);
  const timeOfDay = useGameStore((s) => s.environment.timeOfDay);
  const setTimeOfDay = useGameStore((s) => s.setTimeOfDay);

  const [panel, setPanel] = useState<'none' | 'worlds' | 'settings'>('none');
  const [worlds, setWorlds] = useState<WorldMeta[]>([]);
  const [activeWorldId, setActiveWorldId] = useState<string | null>(null);

  const refreshWorlds = () => {
    listWorlds().then((w) => {
      setWorlds(w.slice().sort((a, b) => b.lastPlayedAt - a.lastPlayedAt));
      setActiveWorldId(getActiveWorld()?.id ?? null);
    });
  };
  useEffect(() => { refreshWorlds(); }, []);

  if (gameMode !== GameMode.Explore) return null;

  const isLoadingHD = textureState === 'loading-high';
  const hasHD = textureState === 'high';
  const toggleHD = () => {
    if (isLoadingHD) return;
    if (hasHD) materialManager.downgradeToLowResolution();
    else materialManager.upgradeToHighResolution();
  };
  const selectWorld = async (id: string) => { await setActiveWorld(id); refreshWorlds(); setPanel('none'); };
  const newWorld = async () => { await createAndActivateWorld(); refreshWorlds(); setPanel('none'); };
  const removeWorld = async (id: string) => { await deleteWorld(id); refreshWorlds(); };

  const pill = (active: boolean) =>
    `py-1 flex-1 text-xs rounded-lg transition-colors text-center cursor-pointer ${
      active ? 'text-white bg-indigo-600' : 'text-white/60 bg-white/10 hover:bg-white/20'
    }`;
  const bottomBtn = (active: boolean) =>
    `pointer-events-auto px-5 py-2.5 rounded-xl text-sm font-semibold shadow-lg transition-colors ${
      active ? 'bg-indigo-600 text-white' : 'bg-black/50 text-white hover:bg-black/70 border border-white/15'
    }`;

  return (
    <div className="fixed inset-0 z-50 pointer-events-none">
      {/* Logo — top center, clear of the debug/FPS counter (top-left) */}
      <img
        src="/wrldy-logo-white.svg"
        alt="wrldy"
        className="absolute top-3 left-1/2 -translate-x-1/2 h-10 pointer-events-none drop-shadow-lg"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      />

      {/* Marker-tracking Play button */}
      <MarkerPlayButton />

      {/* Panels (open above the bottom bar) */}
      {panel !== 'none' && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-20 w-[min(92vw,22rem)] pointer-events-auto">
          {panel === 'worlds' && (
            <div className="rounded-2xl bg-black/80 border border-white/10 p-2 flex flex-col gap-1">
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
              <button onClick={newWorld} className="text-sm px-2 py-1.5 rounded-lg text-cyan-300 hover:bg-white/10 text-left">
                ＋ New World
              </button>
            </div>
          )}

          {panel === 'settings' && (
            <div className="rounded-2xl bg-black/80 border border-white/10 py-3 px-4 flex flex-col gap-2.5 max-h-[60vh] overflow-y-auto">
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
          )}
        </div>
      )}

      {/* Bottom bar: Worlds + Settings */}
      <div
        className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-3"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <button className={bottomBtn(panel === 'worlds')} onClick={() => setPanel((p) => (p === 'worlds' ? 'none' : 'worlds'))}>
          🌐 Worlds
        </button>
        <button className={bottomBtn(panel === 'settings')} onClick={() => setPanel((p) => (p === 'settings' ? 'none' : 'settings'))}>
          ⚙ Settings
        </button>
      </div>
    </div>
  );
}
