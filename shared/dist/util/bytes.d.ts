/**
 * Binary encoding/decoding utilities
 */
export declare class ByteWriter {
    private buffer;
    private view;
    private offset;
    constructor(size?: number);
    writeUint8(value: number): void;
    writeUint16(value: number): void;
    writeUint32(value: number): void;
    writeFloat32(value: number): void;
    writeInt16(value: number): void;
    private ensureCapacity;
    toArrayBuffer(): ArrayBuffer;
    toUint8Array(): Uint8Array;
}
export declare class ByteReader {
    private view;
    private offset;
    constructor(buffer: ArrayBuffer | Uint8Array);
    readUint8(): number;
    readUint16(): number;
    readUint32(): number;
    readFloat32(): number;
    readInt16(): number;
    get remaining(): number;
}
//# sourceMappingURL=bytes.d.ts.map