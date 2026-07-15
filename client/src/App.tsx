import { useEffect, useRef } from 'react';
import { Hud } from './ui/Hud';
import { DebugPanel } from './ui/DebugPanel';
import { ExploreOverlay } from './ui/ExploreOverlay';
import { BuildMenu } from './ui/BuildMenu';
import { ControlsHint } from './ui/ControlsHint';
import { MapOverlay } from './ui/MapOverlay';
import { MobileControls } from './ui/MobileControls';
import { Hotbar } from './ui/Hotbar';
import { ExploreControls } from './ui/ExploreControls';
import { useGameStore } from './state/store';
import { useIsTouch } from './ui/useDeviceMode';
import { createGame } from './game/createGame';
import { preloadPresetThumbnails } from './ui/PresetThumbnailRenderer';
import { GameMode } from '@worldify/shared';

function App() {
  const connectionStatus = useGameStore((s) => s.connectionStatus);
  const gameMode = useGameStore((s) => s.gameMode);
  const firstPersonReady = useGameStore((s) => s.firstPersonReady);
  const isTouch = useIsTouch();
  const bootStarted = useRef(false);

  // Boot the local world on load so the home screen shows the rotating-camera
  // world in the background and terrain (+ colliders) generate before the
  // player ever spawns. Multiplayer stays offline; the menu drives Play.
  useEffect(() => {
    if (bootStarted.current) return;
    bootStarted.current = true;
    createGame('local').catch((err) => console.error('[game] local boot failed:', err));
    // Warm the build-menu thumbnail cache in the background (lowest priority;
    // the queue waits for the renderer to exist).
    preloadPresetThumbnails();
  }, []);

  const isPlaying = gameMode === GameMode.Playing;
  const isExplore = gameMode === GameMode.Explore;
  const inGame = connectionStatus === 'connected';

  return (
    <>
      {/* Explore-mode camera drag/rotate/zoom surface (below the home overlay). */}
      {inGame && isExplore && <ExploreControls />}
      <ExploreOverlay />
      {inGame && (
        /* Single fixed overlay for all HUD elements — one compositor layer */
        <div className="fixed inset-0 z-50 pointer-events-none">
          {isPlaying && (
            <>
              <Hud />
              <BuildMenu />
            </>
          )}
          {/* Map shows in both play and explore. */}
          {(isPlaying || isExplore) && <MapOverlay />}
          {/* Kept mounted across play↔explore so they slide in/out via firstPersonReady. */}
          <Hotbar />
          {!isTouch && <ControlsHint />}
          <DebugPanel />
        </div>
      )}

      {/* Touch controls (mobile) — shown only after the play-entry camera transition completes */}
      {inGame && isPlaying && isTouch && firstPersonReady && <MobileControls />}
    </>
  );
}

export default App;
