/**
 * Binary message encoding (server -> client)
 * 
 * NOTE: For shared encode functions (encodeSnapshot),
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
 * Encode WELCOME message (server-specific: includes room ID as length-prefixed string)
 */
export function encodeWelcome(playerId: number, roomId: string): Uint8Array {
  const roomBytes = Buffer.from(roomId, 'utf8');
  const writer = new ByteWriter(4 + roomBytes.length);
  writer.writeUint8(MSG_WELCOME);
  writer.writeUint16(playerId);
  // Write room ID as length-prefixed string
  writer.writeUint8(roomBytes.length);
  for (let i = 0; i < roomBytes.length; i++) {
    writer.writeUint8(roomBytes[i]);
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
