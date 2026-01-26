import { GameCore } from './GameCore';
import { storeBridge } from '../state/bridge';
import { connectToServer, getPlayerId } from '../net/netClient';

let gameCore: GameCore | null = null;

export async function createGame(): Promise<GameCore> {
  if (gameCore) {
    return gameCore;
  }

  storeBridge.updateConnectionStatus('connecting');

  // Create game core
  gameCore = new GameCore();
  await gameCore.init();

  // Connect to server
  await connectToServer();

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
