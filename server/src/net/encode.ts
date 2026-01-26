/**
 * Binary message encoding (server -> client)
 */

import {
  MSG_WELCOME,
  MSG_ROOM_INFO,
  MSG_PONG,
  ByteWriter,
  RoomSnapshot,
  encodeSnapshot as sharedEncodeSnapshot,
  encodeBuildCommit as sharedEncodeBuildCommit,
  encodeBuildSync as sharedEncodeBuildSync,
  BuildCommit,
} from '@worldify/shared';

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

export function encodeRoomInfo(playerCount: number): Uint8Array {
  const writer = new ByteWriter(4);
  writer.writeUint8(MSG_ROOM_INFO);
  writer.writeUint8(playerCount);
  return writer.toUint8Array();
}

export function encodeSnapshot(snapshot: RoomSnapshot): Uint8Array {
  return sharedEncodeSnapshot(snapshot);
}

export function encodeBuildCommit(commit: BuildCommit): Uint8Array {
  return sharedEncodeBuildCommit(commit);
}

export function encodeBuildSync(startSeq: number, commits: BuildCommit[]): Uint8Array {
  return sharedEncodeBuildSync(startSeq, commits);
}

export function encodePong(timestamp: number): Uint8Array {
  const writer = new ByteWriter(8);
  writer.writeUint8(MSG_PONG);
  writer.writeUint32(timestamp);
  return writer.toUint8Array();
}
