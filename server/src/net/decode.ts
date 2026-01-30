/**
 * Binary message decoding (client -> server)
 * Uses MessageRegistry pattern for extensible message handling.
 */

import {
  MSG_JOIN,
  MSG_INPUT,
  MSG_PING,
  ByteReader,
  decodeInput,
} from '@worldify/shared';
import { roomManager } from '../rooms/roomManager.js';
import { encodePong } from '@worldify/shared';
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
registerHandler(MSG_PING, handlePing);
