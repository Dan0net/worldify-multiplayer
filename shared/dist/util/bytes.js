/**
 * Binary encoding/decoding utilities
 */
export class ByteWriter {
    buffer;
    view;
    offset = 0;
    constructor(size = 256) {
        this.buffer = new ArrayBuffer(size);
        this.view = new DataView(this.buffer);
    }
    writeUint8(value) {
        this.ensureCapacity(1);
        this.view.setUint8(this.offset++, value);
    }
    writeUint16(value) {
        this.ensureCapacity(2);
        this.view.setUint16(this.offset, value, true);
        this.offset += 2;
    }
    writeUint32(value) {
        this.ensureCapacity(4);
        this.view.setUint32(this.offset, value, true);
        this.offset += 4;
    }
    writeFloat32(value) {
        this.ensureCapacity(4);
        this.view.setFloat32(this.offset, value, true);
        this.offset += 4;
    }
    writeInt16(value) {
        this.ensureCapacity(2);
        this.view.setInt16(this.offset, value, true);
        this.offset += 2;
    }
    ensureCapacity(bytes) {
        if (this.offset + bytes > this.buffer.byteLength) {
            const newBuffer = new ArrayBuffer(this.buffer.byteLength * 2);
            new Uint8Array(newBuffer).set(new Uint8Array(this.buffer));
            this.buffer = newBuffer;
            this.view = new DataView(this.buffer);
        }
    }
    toArrayBuffer() {
        return this.buffer.slice(0, this.offset);
    }
    toUint8Array() {
        return new Uint8Array(this.buffer, 0, this.offset);
    }
}
export class ByteReader {
    view;
    offset = 0;
    constructor(buffer) {
        if (buffer instanceof Uint8Array) {
            this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        }
        else {
            this.view = new DataView(buffer);
        }
    }
    readUint8() {
        return this.view.getUint8(this.offset++);
    }
    readUint16() {
        const value = this.view.getUint16(this.offset, true);
        this.offset += 2;
        return value;
    }
    readUint32() {
        const value = this.view.getUint32(this.offset, true);
        this.offset += 4;
        return value;
    }
    readFloat32() {
        const value = this.view.getFloat32(this.offset, true);
        this.offset += 4;
        return value;
    }
    readInt16() {
        const value = this.view.getInt16(this.offset, true);
        this.offset += 2;
        return value;
    }
    get remaining() {
        return this.view.byteLength - this.offset;
    }
}
//# sourceMappingURL=bytes.js.map