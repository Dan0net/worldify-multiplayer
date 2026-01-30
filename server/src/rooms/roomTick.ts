/**
 * Room tick logic
 * Server tick runs at SERVER_TICK_HZ (physics/game logic)
 * Snapshots broadcast at SNAPSHOT_HZ (network sync)
 * 
 * NOTE: Physics are handled client-side for voxel terrain collision.
 * Server just relays positions and handles horizontal movement.
 */

import { WebSocket } from 'ws';
import { Room, PlayerState } from './room.js';
import { 
  SERVER_TICK_HZ, 
  SNAPSHOT_HZ,
  INPUT_SPRINT,
  PlayerSnapshot,
  FLAG_SPRINTING,
  // Physics constants from shared (ensures client/server consistency)
  MOVE_SPEED,
  SPRINT_MULTIPLIER,
  // Movement utilities from shared
  getWorldDirectionFromInput,
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
  const dt = 1 / SERVER_TICK_HZ;
  
  // Process each player's movement based on their last input
  for (const player of room.players.values()) {
    processPlayerMovement(player, dt);
  }
  
  // TODO: apply consume wave logic
  // TODO: check territory conditions
}

function processPlayerMovement(player: PlayerState, dt: number): void {
  const buttons = player.buttons;
  
  // Server only handles horizontal movement
  // Client handles vertical physics (gravity, jump, voxel collision)
  
  // Calculate horizontal movement using shared utility
  const worldDir = getWorldDirectionFromInput(buttons, player.yaw);
  if (worldDir) {
    // Apply speed
    let speed = MOVE_SPEED;
    if (buttons & INPUT_SPRINT) {
      speed *= SPRINT_MULTIPLIER;
      player.flags |= FLAG_SPRINTING;
    } else {
      player.flags &= ~FLAG_SPRINTING;
    }
    
    player.x += worldDir.worldX * speed * dt;
    player.z += worldDir.worldZ * speed * dt;
  }
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
