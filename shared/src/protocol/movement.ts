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
 * │ 8-11        │ float32│ X position                               │
 * │ 12-15       │ float32│ Y position                               │
 * │ 16-19       │ float32│ Z position                               │
 * └─────────────┴────────┴──────────────────────────────────────────┘
 * Total: 20 bytes
 */

import { ByteReader, ByteWriter } from '../util/bytes.js';
import { quantizeAngle, dequantizeAngle } from '../util/quantize.js';
import { MSG_INPUT } from './msgIds.js';

// Input button bitmask
export const INPUT_FORWARD = 1 << 0;
export const INPUT_BACKWARD = 1 << 1;
export const INPUT_LEFT = 1 << 2;
export const INPUT_RIGHT = 1 << 3;
export const INPUT_JUMP = 1 << 4;
export const INPUT_SPRINT = 1 << 5;

export interface MovementInput {
  buttons: number; // bitmask
  yaw: number; // radians
  pitch: number; // radians
  seq: number; // client sequence number
  x: number; // client-authoritative position
  y: number;
  z: number;
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
export function encodeInput(input: MovementInput): Uint8Array {
  const writer = new ByteWriter(20);
  writer.writeUint8(MSG_INPUT);
  writer.writeUint8(input.buttons);
  writer.writeInt16(quantizeAngle(input.yaw));
  writer.writeInt16(quantizeAngle(input.pitch));
  writer.writeUint16(input.seq);
  writer.writeFloat32(input.x);
  writer.writeFloat32(input.y);
  writer.writeFloat32(input.z);
  return writer.toUint8Array();
}

/**
 * Decode movement input from network data
 */
export function decodeInput(reader: ByteReader): MovementInput {
  return {
    buttons: reader.readUint8(),
    yaw: dequantizeAngle(reader.readInt16()),
    pitch: dequantizeAngle(reader.readInt16()),
    seq: reader.readUint16(),
    x: reader.readFloat32(),
    y: reader.readFloat32(),
    z: reader.readFloat32(),
  };
}
