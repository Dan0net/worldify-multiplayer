import { useEffect, useRef } from 'react';
import { Hud } from './ui/Hud';
import { DebugPanel } from './ui/DebugPanel';
import { SpectatorOverlay } from './ui/SpectatorOverlay';
import { BuildToolbar } from './ui/BuildToolbar';
import { MapOverlay } from './ui/MapOverlay';
import { useGameStore } from './state/store';
import { createGame } from './game/createGame';
import { GameMode } from '@worldify/shared';

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
        <>
          {isPlaying && (
            <>
              <Hud />
              <BuildToolbar />
              <MapOverlay />
            </>
          )}
          <DebugPanel />
        </>
      )}
    </>
  );
}

export default App;
