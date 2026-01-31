import { GameCore } from './GameCore';
import { storeBridge } from '../state/bridge';
import { connectToServer, getPlayerId, setOnReconnected } from '../net/netClient';

let gameCore: GameCore | null = null;

export async function createGame(): Promise<GameCore> {
  if (gameCore) {
    return gameCore;
  }

  storeBridge.updateConnectionStatus('connecting');

  // Connect to server FIRST so WebSocket is ready for chunk requests
  await connectToServer();

  // Create and initialize game core (will request chunks from server)
  gameCore = new GameCore();
  await gameCore.init();

  // Set local player ID so GameCore knows which player to skip in snapshots
  const playerId = getPlayerId();
  if (playerId !== null) {
    gameCore.setLocalPlayerId(playerId);
  }

  // Set up reconnection handler to update player ID after reconnect
  setOnReconnected(() => {
    const newPlayerId = getPlayerId();
    if (gameCore && newPlayerId !== null) {
      console.log(`[game] Reconnected with new player ID: ${newPlayerId}`);
      gameCore.setLocalPlayerId(newPlayerId);
    }
  });

  return gameCore;
}

export function getGameCore(): GameCore | null {
  return gameCore;
}
