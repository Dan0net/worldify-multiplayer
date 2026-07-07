import { useEffect, useRef } from 'react';
import { Hud } from './ui/Hud';
import { DebugPanel } from './ui/DebugPanel';
import { SpectatorOverlay } from './ui/SpectatorOverlay';
import { BuildToolbar } from './ui/BuildToolbar';
import { MapOverlay } from './ui/MapOverlay';
import { MobileControls } from './ui/MobileControls';
import { RotateDevicePrompt } from './ui/RotateDevicePrompt';
import { useGameStore } from './state/store';
import { useIsTouch } from './ui/useDeviceMode';
import { createGame } from './game/createGame';
import { GameMode } from '@worldify/shared';

function App() {
  const connectionStatus = useGameStore((s) => s.connectionStatus);
  const gameMode = useGameStore((s) => s.gameMode);
  const isTouch = useIsTouch();
  const joinAttempted = useRef(false);

  // Auto-join on mount - skip menu, go straight to spectator mode
  useEffect(() => {
    if (!joinAttempted.current) {
      joinAttempted.current = true;
      createGame();
    }
  }, []);

  const isPlaying = gameMode === GameMode.Playing;

  return (
    <>
      <SpectatorOverlay />
      {connectionStatus === 'connected' && (
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

      {/* Touch controls (mobile) — sit above the canvas, below the HUD layer */}
      {connectionStatus === 'connected' && isPlaying && isTouch && <MobileControls />}

      {/* Portrait rotate prompt — self-gates to touch + portrait */}
      <RotateDevicePrompt />
    </>
  );
}

export default App;
