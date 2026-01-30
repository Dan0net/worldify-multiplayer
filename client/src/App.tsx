import { useEffect, useRef } from 'react';
import { Hud } from './ui/Hud';
import { DebugPanel } from './ui/DebugPanel';
import { SpectatorOverlay } from './ui/SpectatorOverlay';
import { BuildToolbar } from './ui/BuildToolbar';
import { useGameStore } from './state/store';
import { createGame } from './game/createGame';

function App() {
  const connectionStatus = useGameStore((s) => s.connectionStatus);
  const joinAttempted = useRef(false);

  // Auto-join on mount - skip menu, go straight to spectator mode
  useEffect(() => {
    if (!joinAttempted.current) {
      joinAttempted.current = true;
      createGame();
    }
  }, []);

  return (
    <>
      <SpectatorOverlay />
      {connectionStatus === 'connected' && (
        <>
          <Hud />
          <BuildToolbar />
          <DebugPanel />
        </>
      )}
    </>
  );
}

export default App;
