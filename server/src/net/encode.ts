/**
 * Binary message encoding (server -> client)
 * 
 * NOTE: For shared encode functions (encodeSnapshot, encodeBuildCommit, encodeBuildSync),
 * import directly from '@worldify/shared' instead of this module.
 * This module only contains server-specific encoding functions.
 */

import {
  MSG_WELCOME,
  MSG_ROOM_INFO,
  MSG_PONG,
  ByteWriter,
} from '@worldify/shared';

/**
 * Encode WELCOME message (server-specific: includes room ID as fixed bytes)
 */
export function encodeWelcome(playerId: number, roomId: string): Uint8Array {
  const writer = new ByteWriter(32);
  writer.writeUint8(MSG_WELCOME);
  writer.writeUint16(playerId);
  // Write room ID as fixed 8 bytes (hex)
  const roomBytes = Buffer.from(roomId, 'utf8');
  for (let i = 0; i < 8; i++) {
    writer.writeUint8(roomBytes[i] || 0);
  }
  return writer.toUint8Array();
}

/**
 * Encode ROOM_INFO message (server-specific)
 */
export function encodeRoomInfo(playerCount: number): Uint8Array {
  const writer = new ByteWriter(4);
  writer.writeUint8(MSG_ROOM_INFO);
  writer.writeUint8(playerCount);
  return writer.toUint8Array();
}

/**
 * Encode PONG message (server-specific: echoes client timestamp)
 */
export function encodePong(timestamp: number): Uint8Array {
  const writer = new ByteWriter(8);
  writer.writeUint8(MSG_PONG);
  writer.writeUint32(timestamp);
  return writer.toUint8Array();
}
