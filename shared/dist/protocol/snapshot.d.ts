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
import { ByteReader } from '../util/bytes.js';
export declare const FLAG_GROUNDED: number;
export declare const FLAG_SPRINTING: number;
export declare const FLAG_BUILDING: number;
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
export declare const PLAYER_SNAPSHOT_BYTES = 14;
/**
 * Encode a room snapshot for network transmission
 */
export declare function encodeSnapshot(snapshot: RoomSnapshot): Uint8Array;
/**
 * Decode a room snapshot from network data
 */
export declare function decodeSnapshot(reader: ByteReader): RoomSnapshot;
//# sourceMappingURL=snapshot.d.ts.map