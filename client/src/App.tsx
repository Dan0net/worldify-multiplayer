import { useEffect, useState } from 'react';
import { Landing } from './ui/Landing';
import { Hud } from './ui/Hud';
import { DebugPanel } from './ui/DebugPanel';
import { SpectatorOverlay } from './ui/SpectatorOverlay';
import { BuildToolbar } from './ui/BuildToolbar';
import { useGameStore } from './state/store';
import { createGame } from './game/createGame';

function App() {
  const connectionStatus = useGameStore((s) => s.connectionStatus);
  const [gameInitialized, setGameInitialized] = useState(false);

  useEffect(() => {
    // Game will be initialized when player joins
  }, []);

  const handleJoin = async () => {
    if (!gameInitialized) {
      await createGame();
      setGameInitialized(true);
    }
  };

  return (
    <>
      {connectionStatus === 'disconnected' && <Landing onJoin={handleJoin} />}
      {connectionStatus !== 'disconnected' && (
        <>
          <SpectatorOverlay />
          <Hud />
          <BuildToolbar />
          <DebugPanel />
        </>
      )}
    </>
  );
}

export default App;
