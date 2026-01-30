/**
 * Room tick logic
 * Server tick runs at SERVER_TICK_HZ (physics/game logic)
 * Snapshots broadcast at SNAPSHOT_HZ (network sync)
 * 
 * NOTE: Movement is client-authoritative. Server just relays positions
 * received from clients to other clients via snapshots.
 */

import { WebSocket } from 'ws';
import { Room } from './room.js';
import { 
  SERVER_TICK_HZ, 
  SNAPSHOT_HZ,
  PlayerSnapshot,
  // Encode functions from shared
  encodeSnapshot,
} from '@worldify/shared';

const TICK_INTERVAL_MS = 1000 / SERVER_TICK_HZ;
const SNAPSHOT_INTERVAL_MS = 1000 / SNAPSHOT_HZ;

export function startRoomTick(room: Room): void {
  // Start game tick
  room.tickInterval = setInterval(() => {
    tick(room);
  }, TICK_INTERVAL_MS);
  
  // Start snapshot broadcast (separate from game tick for flexibility)
  room.snapshotInterval = setInterval(() => {
    broadcastSnapshot(room);
  }, SNAPSHOT_INTERVAL_MS);
  
  console.log(`[room ${room.id}] Started ticks (${SERVER_TICK_HZ}Hz) and snapshots (${SNAPSHOT_HZ}Hz)`);
}

export function stopRoomTick(room: Room): void {
  if (room.tickInterval) {
    clearInterval(room.tickInterval);
    room.tickInterval = null;
  }
  if (room.snapshotInterval) {
    clearInterval(room.snapshotInterval);
    room.snapshotInterval = null;
  }
  console.log(`[room ${room.id}] Stopped ticks`);
}

function tick(room: Room): void {
  room.tick++;
  
  // Movement is client-authoritative, so no physics processing here.
  // Server just relays positions via snapshots.
  
  // TODO: apply consume wave logic
  // TODO: check territory conditions
}

function broadcastSnapshot(room: Room): void {
  if (room.connections.size === 0) return;
  
  // Build player snapshot array
  const players: PlayerSnapshot[] = [];
  for (const player of room.players.values()) {
    players.push({
      playerId: player.playerId,
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: player.yaw,
      pitch: player.pitch,
      buttons: player.buttons,
      flags: player.flags,
    });
  }
  
  const snapshotData = encodeSnapshot({ tick: room.tick, players });
  
  // Broadcast to all connected players
  for (const ws of room.connections.values()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(snapshotData);
    }
  }
}
