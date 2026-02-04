/**
 * Map tile binary messages
 * 
 * MAP_TILE_REQUEST Binary Layout (Client -> Server):
 * ┌─────────────┬─────────┬──────────────────────────────────────────┐
 * │ Byte Offset │ Type    │ Description                              │
 * ├─────────────┼─────────┼──────────────────────────────────────────┤
 * │ 0           │ uint8   │ MSG_MAP_TILE_REQUEST (0x08)              │
 * │ 1-2         │ int16   │ Tile X coordinate                        │
 * │ 3-4         │ int16   │ Tile Z coordinate                        │
 * └─────────────┴─────────┴──────────────────────────────────────────┘
 * Total: 5 bytes
 * 
 * MAP_TILE_DATA Binary Layout (Server -> Client):
 * ┌─────────────┬─────────┬──────────────────────────────────────────┐
 * │ Byte Offset │ Type    │ Description                              │
 * ├─────────────┼─────────┼──────────────────────────────────────────┤
 * │ 0           │ uint8   │ MSG_MAP_TILE_DATA (0x89)                 │
 * │ 1-2         │ int16   │ Tile X coordinate                        │
 * │ 3-4         │ int16   │ Tile Z coordinate                        │
 * │ 5-2052      │ int16[] │ Heights (1024 × int16 = 2048 bytes)      │
 * │ 2053-3076   │ uint8[] │ Materials (1024 × uint8 = 1024 bytes)    │
 * └─────────────┴─────────┴──────────────────────────────────────────┘
 * Total: 3077 bytes
 */

import { ByteReader, ByteWriter } from '../util/bytes.js';
import { MAP_TILE_PIXELS } from '../maptile/constants.js';
import type { MapTileData } from '../maptile/MapTileData.js';

// ============== Message IDs ==============

export const MSG_MAP_TILE_REQUEST = 0x08;
export const MSG_MAP_TILE_DATA = 0x89;

// ============== Types ==============

export interface MapTileRequest {
  tx: number;
  tz: number;
}

export interface MapTileResponse {
  tx: number;
  tz: number;
  heights: Int16Array;
  materials: Uint8Array;
}

// ============== Encoding ==============

/**
 * Encode a map tile request
 */
export function encodeMapTileRequest(request: MapTileRequest): ArrayBuffer {
  const writer = new ByteWriter(5);
  writer.writeUint8(MSG_MAP_TILE_REQUEST);
  writer.writeInt16(request.tx);
  writer.writeInt16(request.tz);
  return writer.toArrayBuffer();
}

/**
 * Decode a map tile request
 */
export function decodeMapTileRequest(reader: ByteReader): MapTileRequest {
  return {
    tx: reader.readInt16(),
    tz: reader.readInt16(),
  };
}

/**
 * Encode map tile data for network transmission
 */
export function encodeMapTileData(tile: MapTileData): ArrayBuffer {
  // 1 byte msgId + 2 bytes tx + 2 bytes tz + 2048 heights + 1024 materials
  const writer = new ByteWriter(3077);
  writer.writeUint8(MSG_MAP_TILE_DATA);
  writer.writeInt16(tile.tx);
  writer.writeInt16(tile.tz);
  
  // Write heights as int16 array
  for (let i = 0; i < MAP_TILE_PIXELS; i++) {
    writer.writeInt16(tile.heights[i]);
  }
  
  // Write materials as uint8 array
  for (let i = 0; i < MAP_TILE_PIXELS; i++) {
    writer.writeUint8(tile.materials[i]);
  }
  
  return writer.toArrayBuffer();
}

/**
 * Decode map tile data from network
 */
export function decodeMapTileData(reader: ByteReader): MapTileResponse {
  const tx = reader.readInt16();
  const tz = reader.readInt16();
  
  const heights = new Int16Array(MAP_TILE_PIXELS);
  for (let i = 0; i < MAP_TILE_PIXELS; i++) {
    heights[i] = reader.readInt16();
  }
  
  const materials = new Uint8Array(MAP_TILE_PIXELS);
  for (let i = 0; i < MAP_TILE_PIXELS; i++) {
    materials[i] = reader.readUint8();
  }
  
  return { tx, tz, heights, materials };
}
