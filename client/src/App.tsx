import { useEffect, useRef } from 'react';
import { Hud } from './ui/Hud';
import { DebugPanel } from './ui/DebugPanel';
import { SpectatorOverlay } from './ui/SpectatorOverlay';
import { BuildToolbar } from './ui/BuildToolbar';
import { MapOverlay } from './ui/MapOverlay';
import { MobileControls } from './ui/MobileControls';
import { useGameStore } from './state/store';
import { useIsTouch } from './ui/useDeviceMode';
import { createGame } from './game/createGame';
import { GameMode } from '@worldify/shared';

function App() {
  const connectionStatus = useGameStore((s) => s.connectionStatus);
  const gameMode = useGameStore((s) => s.gameMode);
  const isTouch = useIsTouch();
  const bootStarted = useRef(false);

  // Boot the local world on load so the home screen shows the rotating-camera
  // world in the background and terrain (+ colliders) generate before the
  // player ever spawns. Multiplayer stays offline; the menu drives Play.
  useEffect(() => {
    if (bootStarted.current) return;
    bootStarted.current = true;
    createGame('local').catch((err) => console.error('[game] local boot failed:', err));
  }, []);

  const isPlaying = gameMode === GameMode.Playing;
  const inGame = connectionStatus === 'connected';

  return (
    <>
      <SpectatorOverlay />
      {inGame && (
        /* Single fixed overlay for all HUD elements — one compositor layer */
        <div className="fixed inset-0 z-50 pointer-events-none">
          {isPlaying && (
            <>
              <Hud />
              <BuildToolbar />
              <MapOverlay />
            </>
          )}
          <DebugPanel />
        </div>
      )}

      {/* Touch controls (mobile) — above the canvas, below the HUD layer */}
      {inGame && isPlaying && isTouch && <MobileControls />}
    </>
  );
}

export default App;
