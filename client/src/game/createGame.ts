import { GameCore } from './GameCore';
import { storeBridge } from '../state/bridge';
import { connectToServer, getPlayerId } from '../net/netClient';

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

  return gameCore;
}

export function getGameCore(): GameCore | null {
  return gameCore;
}
