/**
 * Snapshot message types and binary encoding
 * 
 * SNAPSHOT Binary Layout (Server -> Client):
 * ┌─────────────┬────────┬──────────────────────────────────────────┐
 * │ Byte Offset │ Type   │ Description                              │
 * ├─────────────┼────────┼──────────────────────────────────────────┤
 * │ 0           │ uint8  │ MSG_SNAPSHOT (0x82)                      │
 * │ 1-4         │ uint32 │ Server tick number                       │
 * │ 5           │ uint8  │ Player count (N)                         │
 * │ 6+          │ Player │ N × PlayerSnapshot (14 bytes each)       │
 * └─────────────┴────────┴──────────────────────────────────────────┘
 * 
 * PlayerSnapshot Binary Layout (14 bytes):
 * ┌─────────────┬────────┬──────────────────────────────────────────┐
 * │ Byte Offset │ Type   │ Description                              │
 * ├─────────────┼────────┼──────────────────────────────────────────┤
 * │ 0-1         │ uint16 │ Player ID                                │
 * │ 2-3         │ int16  │ X position (quantized, cm)               │
 * │ 4-5         │ int16  │ Y position (quantized, cm)               │
 * │ 6-7         │ int16  │ Z position (quantized, cm)               │
 * │ 8-9         │ int16  │ Yaw (quantized radians)                  │
 * │ 10-11       │ int16  │ Pitch (quantized radians)                │
 * │ 12          │ uint8  │ Buttons bitmask (current input state)    │
 * │ 13          │ uint8  │ Flags (grounded, sprinting, etc.)        │
 * └─────────────┴────────┴──────────────────────────────────────────┘
 */

import { ByteReader, ByteWriter } from '../util/bytes.js';
import { quantizeAngle, dequantizeAngle, quantizePosition, dequantizePosition } from '../util/quantize.js';
import { MSG_SNAPSHOT } from './msgIds.js';

// Player state flags
export const FLAG_GROUNDED = 1 << 0;
export const FLAG_SPRINTING = 1 << 1;
export const FLAG_BUILDING = 1 << 2;

export interface PlayerSnapshot {
  playerId: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  buttons: number;
  flags: number;
}

export interface RoomSnapshot {
  tick: number;
  players: PlayerSnapshot[];
}

// Bytes per player in snapshot: 2 + 2 + 2 + 2 + 2 + 2 + 1 + 1 = 14
export const PLAYER_SNAPSHOT_BYTES = 14;

/**
 * Encode a room snapshot for network transmission
 */
export function encodeSnapshot(snapshot: RoomSnapshot): Uint8Array {
  const writer = new ByteWriter(6 + snapshot.players.length * PLAYER_SNAPSHOT_BYTES);
  
  writer.writeUint8(MSG_SNAPSHOT);
  writer.writeUint32(snapshot.tick);
  writer.writeUint8(snapshot.players.length);
  
  for (const p of snapshot.players) {
    writer.writeUint16(p.playerId);
    writer.writeInt16(quantizePosition(p.x));
    writer.writeInt16(quantizePosition(p.y));
    writer.writeInt16(quantizePosition(p.z));
    writer.writeInt16(quantizeAngle(p.yaw));
    writer.writeInt16(quantizeAngle(p.pitch));
    writer.writeUint8(p.buttons);
    writer.writeUint8(p.flags);
  }
  
  return writer.toUint8Array();
}

/**
 * Decode a room snapshot from network data
 */
export function decodeSnapshot(reader: ByteReader): RoomSnapshot {
  const tick = reader.readUint32();
  const playerCount = reader.readUint8();
  const players: PlayerSnapshot[] = [];
  
  for (let i = 0; i < playerCount; i++) {
    players.push({
      playerId: reader.readUint16(),
      x: dequantizePosition(reader.readInt16()),
      y: dequantizePosition(reader.readInt16()),
      z: dequantizePosition(reader.readInt16()),
      yaw: dequantizeAngle(reader.readInt16()),
      pitch: dequantizeAngle(reader.readInt16()),
      buttons: reader.readUint8(),
      flags: reader.readUint8(),
    });
  }
  
  return { tick, players };
}
