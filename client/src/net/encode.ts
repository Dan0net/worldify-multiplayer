/**
 * Binary message encoding (client -> server)
 * 
 * NOTE: For shared encode functions (encodeInput, encodeBuildIntent, encodeAckBuild),
 * import directly from '@worldify/shared' instead of this module.
 * This module only contains client-specific encoding functions.
 */

import {
  MSG_JOIN,
  MSG_PING,
  ByteWriter,
} from '@worldify/shared';

/**
 * Encode JOIN message (client-specific: includes playerId from HTTP join)
 */
export function encodeJoin(protocolVersion: number, playerId: number): Uint8Array {
  const writer = new ByteWriter(8);
  writer.writeUint8(MSG_JOIN);
  writer.writeUint8(protocolVersion);
  writer.writeUint16(playerId);
  return writer.toUint8Array();
}

/**
 * Encode PING message (client-specific: uses client timestamp)
 */
export function encodePing(): Uint8Array {
  const writer = new ByteWriter(8);
  writer.writeUint8(MSG_PING);
  writer.writeUint32(Date.now() & 0xffffffff);
  return writer.toUint8Array();
}
