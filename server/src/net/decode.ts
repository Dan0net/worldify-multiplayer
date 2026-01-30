/**
 * Binary message decoding (client -> server)
 * Uses MessageRegistry pattern for extensible message handling.
 */

import {
  MSG_JOIN,
  MSG_INPUT,
  MSG_BUILD_INTENT,
  MSG_ACK_BUILD,
  MSG_PING,
  ByteReader,
  decodeInput,
  decodeBuildIntent,
  encodeBuildCommit,
  encodeBuildSync,
} from '@worldify/shared';
import { roomManager } from '../rooms/roomManager.js';
import { encodePong } from '@worldify/shared';
import { commitBuild, getBuildsSince } from '../rooms/buildLog.js';
import { broadcast } from '../ws/wsServer.js';
import { registerHandler, dispatch } from './MessageRegistry.js';

/**
 * Decode and dispatch an incoming binary message.
 * Delegates to registered handlers via MessageRegistry.
 */
export function decodeMessage(roomId: string, playerId: number, data: Uint8Array): void {
  dispatch(roomId, playerId, data);
}

function handleJoin(_roomId: string, playerId: number, reader: ByteReader): void {
  const protocolVersion = reader.readUint8();
  const clientPlayerId = reader.readUint16();
  console.log(`[join] Player ${playerId} joined with version ${protocolVersion}, claimed ID ${clientPlayerId}`);
}

function handleInput(roomId: string, playerId: number, reader: ByteReader): void {
  const input = decodeInput(reader);
  
  // Update player state in room
  const room = roomManager.getRoom(roomId);
  if (!room) return;
  
  const player = room.players.get(playerId);
  if (!player) return;
  
  // Only accept newer inputs (seq can wrap around)
  const seqDiff = (input.seq - player.lastInputSeq + 65536) % 65536;
  if (seqDiff > 32768) {
    // Old input, ignore
    return;
  }
  
  // Client-authoritative: copy position directly from client
  player.x = input.x;
  player.y = input.y;
  player.z = input.z;
  player.yaw = input.yaw;
  player.pitch = input.pitch;
  player.buttons = input.buttons;
  player.lastInputSeq = input.seq;
  player.lastInputTime = Date.now();
}

function handleBuildIntent(roomId: string, playerId: number, reader: ByteReader): void {
  const intent = decodeBuildIntent(reader);
  
  const room = roomManager.getRoom(roomId);
  if (!room) return;
  
  // Validate placement (basic bounds check)
  if (intent.gridX < 0 || intent.gridX >= 128 || intent.gridZ < 0 || intent.gridZ >= 128) {
    console.warn(`[build] Invalid placement from player ${playerId}: (${intent.gridX}, ${intent.gridZ})`);
    return;
  }
  
  // Validate rotation
  if (intent.rotation < 0 || intent.rotation > 3) {
    console.warn(`[build] Invalid rotation from player ${playerId}: ${intent.rotation}`);
    return;
  }
  
  // Commit the build
  const commit = commitBuild(room, playerId, intent);
  
  // Broadcast BUILD_COMMIT to all clients in room
  const commitData = encodeBuildCommit(commit);
  broadcast(roomId, commitData);
  
  console.log(`[build] Player ${playerId} placed ${intent.pieceType} at (${intent.gridX}, ${intent.gridZ}), seq=${commit.buildSeq}`);
}

function handleAckBuild(roomId: string, playerId: number, reader: ByteReader): void {
  // Client reports its last seen build sequence
  const lastSeenSeq = reader.readUint32();
  
  const room = roomManager.getRoom(roomId);
  if (!room) return;
  
  // Get builds the client hasn't seen yet
  const missedBuilds = getBuildsSince(room, lastSeenSeq);
  
  if (missedBuilds.length === 0) {
    return; // Client is up to date
  }
  
  // Send BUILD_SYNC with all missed builds
  const ws = room.connections.get(playerId);
  if (ws) {
    const startSeq = missedBuilds[0].buildSeq;
    const syncData = encodeBuildSync(startSeq, missedBuilds);
    ws.send(syncData);
    console.log(`[build] Sent BUILD_SYNC to player ${playerId}: ${missedBuilds.length} builds from seq ${startSeq}`);
  }
}

function handlePing(roomId: string, playerId: number, reader: ByteReader): void {
  const timestamp = reader.readUint32();
  
  // Send pong back to this player
  const room = roomManager.getRoom(roomId);
  if (!room) return;
  
  const ws = room.connections.get(playerId);
  if (ws) {
    ws.send(encodePong(timestamp));
  }
}

// Register all message handlers
registerHandler(MSG_JOIN, handleJoin);
registerHandler(MSG_INPUT, handleInput);
registerHandler(MSG_BUILD_INTENT, handleBuildIntent);
registerHandler(MSG_ACK_BUILD, handleAckBuild);
registerHandler(MSG_PING, handlePing);
