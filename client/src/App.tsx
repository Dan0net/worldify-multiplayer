import { useEffect, useRef } from 'react';
import { Hud } from './ui/Hud';
import { DebugPanel } from './ui/DebugPanel';
import { SpectatorOverlay } from './ui/SpectatorOverlay';
import { BuildToolbar } from './ui/BuildToolbar';
import { MapOverlay } from './ui/MapOverlay';
import { MobileControls } from './ui/MobileControls';
import { useGameStore } from './state/store';
import { createGame } from './game/createGame';
import { GameMode } from '@worldify/shared';
import { isTouchDevice } from './game/player/isMobile';

function App() {
  const connectionStatus = useGameStore((s) => s.connectionStatus);
  const gameMode = useGameStore((s) => s.gameMode);
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
              {!isTouchDevice && <BuildToolbar />}
              <MapOverlay />
            </>
          )}
          {!isTouchDevice && <DebugPanel />}
        </div>
      )}
      {/* Mobile touch controls overlay — only when playing on touch devices */}
      {isTouchDevice && isPlaying && <MobileControls />}
    </>
  );
}

export default App;
