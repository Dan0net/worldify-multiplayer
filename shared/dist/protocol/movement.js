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
import { ByteWriter } from '../util/bytes.js';
import { quantizeAngle, dequantizeAngle } from '../util/quantize.js';
import { MSG_INPUT } from './msgIds.js';
// Input button bitmask
export const INPUT_FORWARD = 1 << 0;
export const INPUT_BACKWARD = 1 << 1;
export const INPUT_LEFT = 1 << 2;
export const INPUT_RIGHT = 1 << 3;
export const INPUT_JUMP = 1 << 4;
export const INPUT_SPRINT = 1 << 5;
/**
 * Encode movement input for network transmission
 */
export function encodeInput(input) {
    const writer = new ByteWriter(8);
    writer.writeUint8(MSG_INPUT);
    writer.writeUint8(input.buttons);
    writer.writeInt16(quantizeAngle(input.yaw));
    writer.writeInt16(quantizeAngle(input.pitch));
    writer.writeUint16(input.seq);
    return writer.toUint8Array();
}
/**
 * Decode movement input from network data
 */
export function decodeInput(reader) {
    return {
        buttons: reader.readUint8(),
        yaw: dequantizeAngle(reader.readInt16()),
        pitch: dequantizeAngle(reader.readInt16()),
        seq: reader.readUint16(),
    };
}
//# sourceMappingURL=movement.js.map