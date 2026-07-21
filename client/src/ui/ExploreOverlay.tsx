/**
 * ExploreOverlay — the home screen shown over the free explore camera.
 *
 * No dimming (world renders full brightness). wrldy logo top-center (clear of the
 * FPS/debug counter). Two bottom buttons — Worlds and Settings — each opening a
 * panel. Play is entered via the marker-tracking Play button (below), not a menu
 * button: tap the ground to place a spawn marker, then tap Play to spawn there.
 */

import { useState, useEffect, useRef } from 'react';
import { Globe, Settings, Play, Plus, X, Maximize, Check } from 'lucide-react';
import { useGameStore } from '../state/store';
import { GameMode, type CaveConfig, type TerrainLayerConfig } from '@worldify/shared';
import { materialManager } from '../game/material';
import { QUALITY_LABELS, QUALITY_LEVELS, MSAA_OPTIONS, VIEW_DISTANCES } from '../game/quality/QualityPresets';
import { applyVisibilityRadius, syncQualityToStore } from '../game/quality/QualityManager';
import { getCamera } from '../game/scene/camera';
import { formatTimeOfDay } from '../game/scene/DayNightCycle';
import { isTouch } from '../game/deviceMode';
import { controls } from '../game/player/controls';
import { requestFullscreen } from './fullscreen';
import { NewWorldDialog } from './NewWorldDialog';
import { isMarkerPlaced, getMarkerBase, armMarkerSpawn } from '../game/spawn/SpawnMarker';
import {
  listWorlds, getActiveWorld, setActiveWorld, createAndActivateWorld, deleteWorld,
  subscribeWorldsChanged, type WorldMeta,
} from '../game/world/WorldManager';

/** Fixed on-screen height (px) of the line connecting the ground marker to the Play button. */
const MARKER_LINE_PX = 88;

/**
 * Play button anchored to the spawn marker in screen space. The button + the vertical line
 * beneath it are pure fixed-pixel UI: we project only the marker's ground point and draw a
 * constant-height line up to the button, so the gap never changes with camera zoom (the old
 * 3D line grew/shrank with zoom). The button rides the top of that line.
 */
function MarkerPlayButton() {
  const ref = useRef<HTMLDivElement>(null);
  const touch = isTouch();

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = ref.current;
      const cam = getCamera();
      if (el && cam && isMarkerPlaced()) {
        const p = getMarkerBase().clone().project(cam);
        const onScreen = p.z < 1 && p.x >= -1 && p.x <= 1 && p.y >= -1 && p.y <= 1;
        if (onScreen) {
          el.style.display = '';
          el.style.left = `${(p.x * 0.5 + 0.5) * window.innerWidth}px`;
          el.style.top = `${(-p.y * 0.5 + 0.5) * window.innerHeight}px`;
        } else {
          el.style.display = 'none';
        }
      } else if (el) {
        el.style.display = 'none';
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const play = async (withFullscreen: boolean) => {
    armMarkerSpawn();
    if (touch) {
      // Mobile: enter fullscreen FIRST and wait for it, so the browser finishes the
      // fullscreen animation before the play-mode camera transition begins (no black flash).
      await requestFullscreen();
      useGameStore.getState().setGameMode(GameMode.Playing);
      return;
    }
    // Desktop: lock the pointer within this gesture; optionally go fullscreen too.
    if (withFullscreen) requestFullscreen();
    controls.requestPointerLock();
    useGameStore.getState().setGameMode(GameMode.Playing);
  };

  // Anchored by its bottom-center to the projected ground point; the line's foot sits on the
  // marker and the button floats a fixed MARKER_LINE_PX above it.
  return (
    <div
      ref={ref}
      style={{ position: 'fixed', transform: 'translate(-50%,-100%)', display: 'none' }}
      className="pointer-events-none flex flex-col items-center"
    >
      <div className="pointer-events-auto flex items-stretch rounded-full overflow-hidden shadow-xl border-2 border-[#38e8ff] bg-indigo-600">
        <button
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); play(false); }}
          className="px-8 py-4 md:px-10 md:py-5 text-2xl md:text-3xl font-bold text-white hover:bg-indigo-500 active:bg-indigo-400 flex items-center gap-2 whitespace-nowrap cursor-pointer"
          aria-label="Play from here"
        >
          <Play size={touch ? 22 : 26} fill="currentColor" /> <span className="leading-none">Play</span>
        </button>
        {!touch && (
          <button
            onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); play(true); }}
            className="px-4 border-l border-[#38e8ff]/50 text-white bg-indigo-700 hover:bg-indigo-600 flex items-center cursor-pointer"
            aria-label="Play fullscreen"
            title="Play in fullscreen"
          >
            <Maximize size={22} />
          </button>
        )}
      </div>
      {/* Fixed-height connector line down to the ground marker (constant px at any zoom). */}
      <div style={{ width: 2, height: MARKER_LINE_PX, backgroundColor: '#38e8ff', opacity: 0.85 }} />
    </div>
  );
}

export function ExploreOverlay() {
  const gameMode = useGameStore((s) => s.gameMode);
  const exploreReady = useGameStore((s) => s.exploreReady);
  const textureState = useGameStore((s) => s.textureState);
  const textureProgress = useGameStore((s) => s.textureProgress);
  const qualityLevel = useGameStore((s) => s.qualityLevel);
  const visibilityRadius = useGameStore((s) => s.quality.visibilityRadius);
  const fov = useGameStore((s) => s.fov);
  const renderScale = useGameStore((s) => s.renderScale);
  const setRenderScale = useGameStore((s) => s.setRenderScale);
  const msaaSamples = useGameStore((s) => s.msaaSamples);
  const setMsaaSamples = useGameStore((s) => s.setMsaaSamples);
  const timeOfDay = useGameStore((s) => s.environment.timeOfDay);
  const setTimeOfDay = useGameStore((s) => s.setTimeOfDay);

  const [panel, setPanel] = useState<'none' | 'worlds' | 'settings'>('none');
  const [worlds, setWorlds] = useState<WorldMeta[]>([]);
  const [activeWorldId, setActiveWorldId] = useState<string | null>(null);
  const [showNewWorld, setShowNewWorld] = useState(false);

  // Keep the explore UI (Play button, world/settings bar + panel) mounted through its fade-out so it
  // can animate when leaving to Playing; unmount ~after the transition so it can't capture input.
  const [renderExploreUi, setRenderExploreUi] = useState(gameMode === GameMode.Explore);
  useEffect(() => {
    if (gameMode === GameMode.Explore) { setRenderExploreUi(true); return; }
    const t = setTimeout(() => setRenderExploreUi(false), 550);
    return () => clearTimeout(t);
  }, [gameMode]);

  const refreshWorlds = () => {
    listWorlds().then((w) => {
      setWorlds(w.slice().sort((a, b) => b.lastPlayedAt - a.lastPlayedAt));
      setActiveWorldId(getActiveWorld()?.id ?? null);
    });
  };
  // Refresh on mount and whenever the world list / active world changes (e.g. once the
  // local world finishes booting after this overlay first mounts).
  useEffect(() => {
    refreshWorlds();
    return subscribeWorldsChanged(refreshWorlds);
  }, []);

  const activeWorldName = worlds.find((w) => w.id === activeWorldId)?.name ?? 'Worlds';

  // Render in Explore + Playing (the logo persists into play; the explore UI animates out/in).
  if (gameMode !== GameMode.Explore && gameMode !== GameMode.Playing) return null;

  const isLoadingHD = textureState === 'loading-high';
  const hasHD = textureState === 'high';
  const toggleHD = () => {
    if (isLoadingHD) return;
    if (hasHD) materialManager.downgradeToLowResolution();
    else materialManager.upgradeToHighResolution();
  };
  const selectWorld = async (id: string) => { await setActiveWorld(id); refreshWorlds(); setPanel('none'); };
  const removeWorld = async (id: string) => { await deleteWorld(id); refreshWorlds(); };
  const createWorld = async (name: string, seed: number, caveConfig: CaveConfig, terrainConfig: TerrainLayerConfig, spawnBiome: string) => {
    setShowNewWorld(false);
    await createAndActivateWorld(name, seed, caveConfig, terrainConfig, spawnBiome);
    refreshWorlds();
    setPanel('none');
  };

  const pill = (active: boolean) =>
    `py-1 flex-1 text-xs rounded-lg text-center cursor-pointer ${
      active ? 'text-white bg-indigo-600' : 'text-white/60 bg-white/10 hover:bg-white/20'
    }`;
  const bottomBtn = (active: boolean) =>
    `pointer-events-auto cursor-pointer whitespace-nowrap flex items-center justify-center gap-2 px-6 py-3 md:px-8 md:py-4 rounded-2xl text-2xl md:text-3xl font-bold shadow-lg border ${
      active ? 'bg-indigo-600 text-white border-transparent' : 'bg-black/50 text-white hover:bg-black/70 border-white/15'
    }`;

  return (
    <div className="fixed inset-0 z-50 pointer-events-none">
      {/* Logo — top center, same top offset as the FPS counter pill (top-5). */}
      <img
        src="/wrldy-logo-white.svg"
        alt="wrldy"
        className="absolute top-5 left-1/2 -translate-x-1/2 h-12 md:h-16 pointer-events-none drop-shadow-lg"
      />

      {/* Explore UI (Play button + world/settings bar + panel) — fades out on entering play and
          back in once the play→explore outro completes (exploreReady). Kept mounted briefly during
          the fade via renderExploreUi. Opacity-only on the layer so MarkerPlayButton's own
          marker-tracking transform is undisturbed. */}
      {renderExploreUi && (
      <div className={`absolute inset-0 pointer-events-none transition-opacity duration-500 ease-out ${exploreReady ? 'opacity-100' : 'opacity-0'}`}>
      {/* Marker-tracking Play button */}
      <MarkerPlayButton />

      {/* Bottom stack: an open panel sits directly above the Worlds/Settings bar with a
          constant gap (the flex gap), regardless of the button size. */}
      <div
        className={`absolute bottom-4 left-1/2 -translate-x-1/2 flex flex-col items-center gap-3 w-[calc(100vw-2rem)] md:w-auto transition-transform duration-500 ease-out ${exploreReady ? 'translate-y-0' : 'translate-y-8'}`}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
      {panel !== 'none' && (
        <div className="w-[min(92vw,22rem)] pointer-events-auto">
          {panel === 'worlds' && (
            <div className="rounded-2xl bg-black/80 border border-white/10 p-2 flex flex-col gap-1">
              {worlds.map((w) => (
                <div key={w.id} className="flex items-center gap-1">
                  <button
                    onClick={() => selectWorld(w.id)}
                    className={`flex-1 flex items-center gap-1.5 text-left text-sm px-2 py-1.5 rounded-lg cursor-pointer ${
                      w.id === activeWorldId ? 'bg-indigo-600 text-white' : 'text-white/70 hover:bg-white/10'
                    }`}
                  >
                    {w.id === activeWorldId && <Check size={14} className="shrink-0" />}
                    {w.name}
                  </button>
                  {worlds.length > 1 && (
                    <button
                      onClick={() => removeWorld(w.id)}
                      aria-label={`Delete ${w.name}`}
                      className="w-7 h-7 shrink-0 rounded-lg text-white/40 hover:text-red-400 hover:bg-white/10 flex items-center justify-center cursor-pointer"
                    >
                      <X size={15} />
                    </button>
                  )}
                </div>
              ))}
              <button onClick={() => setShowNewWorld(true)} className="flex items-center gap-1.5 text-sm px-2 py-1.5 rounded-lg text-cyan-300 hover:bg-white/10 text-left cursor-pointer">
                <Plus size={15} /> New World
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
                  {(['Near', 'Close', 'Far', 'Max'] as const).map((label, i) => {
                    const value = VIEW_DISTANCES[i];
                    return (
                      <button key={value} onClick={() => applyVisibilityRadius(value)} className={pill(visibilityRadius === value)}>
                        {label}
                      </button>
                    );
                  })}
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
                <span className="text-white/70 text-sm whitespace-nowrap">MSAA</span>
                <div className="flex gap-1 flex-1">
                  {MSAA_OPTIONS.map((opt) => (
                    <button key={opt.value} onClick={() => setMsaaSamples(opt.value)} className={pill(msaaSamples === opt.value)}>
                      {opt.label}
                    </button>
                  ))}
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

        {/* Worlds + Settings bar — full-width 2-col grid on mobile, centred row on desktop */}
        <div className="grid grid-cols-2 gap-3 w-full md:flex md:w-auto">
          <button className={bottomBtn(panel === 'worlds')} onClick={() => setPanel((p) => (p === 'worlds' ? 'none' : 'worlds'))}>
            <Globe size={26} /> <span className="leading-none">{activeWorldName}</span>
          </button>
          <button className={bottomBtn(panel === 'settings')} onClick={() => setPanel((p) => (p === 'settings' ? 'none' : 'settings'))}>
            <Settings size={26} /> <span className="leading-none">Settings</span>
          </button>
        </div>
      </div>

      {/* New-world prompt (name + seed) */}
      {showNewWorld && (
        <NewWorldDialog onCancel={() => setShowNewWorld(false)} onCreate={createWorld} />
      )}
      </div>
      )}
    </div>
  );
}
