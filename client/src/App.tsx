import { Hud } from './ui/Hud';
import { DebugPanel } from './ui/DebugPanel';
import { SpectatorOverlay } from './ui/SpectatorOverlay';
import { BuildToolbar } from './ui/BuildToolbar';
import { MapOverlay } from './ui/MapOverlay';
import { MobileControls } from './ui/MobileControls';
import { useGameStore } from './state/store';
import { useIsTouch } from './ui/useDeviceMode';
import { GameMode } from '@worldify/shared';

function App() {
  const connectionStatus = useGameStore((s) => s.connectionStatus);
  const gameMode = useGameStore((s) => s.gameMode);
  const isTouch = useIsTouch();

  // The home screen (SpectatorOverlay) starts the game (Local / Multiplayer).
  // No auto-join, so a down multiplayer server never blocks the menu.

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
