import { describe, it, expect } from 'vitest';
import { ByteWriter, ByteReader } from './bytes.js';

describe('ByteWriter + ByteReader', () => {
  it('round-trips primitive types', () => {
    const writer = new ByteWriter();
    writer.writeUint8(255);
    writer.writeUint16(65535);
    writer.writeUint32(0xDEADBEEF);
    writer.writeInt16(-12345);
    writer.writeFloat32(3.14159);

    const reader = new ByteReader(writer.toArrayBuffer());
    expect(reader.readUint8()).toBe(255);
    expect(reader.readUint16()).toBe(65535);
    expect(reader.readUint32()).toBe(0xDEADBEEF);
    expect(reader.readInt16()).toBe(-12345);
    expect(reader.readFloat32()).toBeCloseTo(3.14159, 4);
  });

  it('auto-grows buffer when capacity exceeded', () => {
    const writer = new ByteWriter(4); // Start small
    for (let i = 0; i < 100; i++) {
      writer.writeUint32(i);
    }
    expect(writer.toUint8Array().length).toBe(400);

    const reader = new ByteReader(writer.toArrayBuffer());
    for (let i = 0; i < 100; i++) {
      expect(reader.readUint32()).toBe(i);
    }
  });

  it('creates reader from Uint8Array', () => {
    const writer = new ByteWriter();
    writer.writeUint8(0x42);
    writer.writeUint16(0x1234);

    const arr = writer.toUint8Array();
    const reader = new ByteReader(arr);
    expect(reader.readUint8()).toBe(0x42);
    expect(reader.readUint16()).toBe(0x1234);
  });

  it('tracks offset correctly through mixed reads', () => {
    const writer = new ByteWriter();
    writer.writeUint8(1);    // offset 1
    writer.writeUint32(2);   // offset 5
    writer.writeUint16(3);   // offset 7
    writer.writeFloat32(4);  // offset 11

    const reader = new ByteReader(writer.toArrayBuffer());
    expect(reader.offset).toBe(0);
    reader.readUint8();
    expect(reader.offset).toBe(1);
    reader.readUint32();
    expect(reader.offset).toBe(5);
    reader.readUint16();
    expect(reader.offset).toBe(7);
    reader.readFloat32();
    expect(reader.offset).toBe(11);
  });
});
