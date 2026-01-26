/**
 * Binary message encoding (client -> server)
 */

import {
  MSG_JOIN,
  MSG_PING,
  ByteWriter,
  MovementInput,
  BuildIntent,
  encodeInput as sharedEncodeInput,
  encodeBuildIntent as sharedEncodeBuildIntent,
} from '@worldify/shared';

export function encodeJoin(protocolVersion: number, playerId: number): Uint8Array {
  const writer = new ByteWriter(8);
  writer.writeUint8(MSG_JOIN);
  writer.writeUint8(protocolVersion);
  writer.writeUint16(playerId);
  return writer.toUint8Array();
}

export function encodeInput(input: MovementInput): Uint8Array {
  return sharedEncodeInput(input);
}

export function encodeBuildIntent(intent: BuildIntent): Uint8Array {
  return sharedEncodeBuildIntent(intent);
}

export function encodePing(): Uint8Array {
  const writer = new ByteWriter(8);
  writer.writeUint8(MSG_PING);
  writer.writeUint32(Date.now() & 0xffffffff);
  return writer.toUint8Array();
}
