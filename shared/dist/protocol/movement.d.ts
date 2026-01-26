/**
 * Movement input types and binary encoding
 *
 * INPUT Binary Layout (Client -> Server):
 * ┌─────────────┬────────┬──────────────────────────────────────────┐
 * │ Byte Offset │ Type   │ Description                              │
 * ├─────────────┼────────┼──────────────────────────────────────────┤
 * │ 0           │ uint8  │ MSG_INPUT (0x02)                         │
 * │ 1           │ uint8  │ Buttons bitmask                          │
 * │ 2-3         │ int16  │ Yaw (quantized radians)                  │
 * │ 4-5         │ int16  │ Pitch (quantized radians)                │
 * │ 6-7         │ uint16 │ Client sequence number                   │
 * └─────────────┴────────┴──────────────────────────────────────────┘
 * Total: 8 bytes
 */
import { ByteReader } from '../util/bytes.js';
export declare const INPUT_FORWARD: number;
export declare const INPUT_BACKWARD: number;
export declare const INPUT_LEFT: number;
export declare const INPUT_RIGHT: number;
export declare const INPUT_JUMP: number;
export declare const INPUT_SPRINT: number;
export interface MovementInput {
    buttons: number;
    yaw: number;
    pitch: number;
    seq: number;
}
export interface PlayerPosition {
    x: number;
    y: number;
    z: number;
    yaw: number;
    pitch: number;
}
/**
 * Encode movement input for network transmission
 */
export declare function encodeInput(input: MovementInput): Uint8Array;
/**
 * Decode movement input from network data
 */
export declare function decodeInput(reader: ByteReader): MovementInput;
//# sourceMappingURL=movement.d.ts.map