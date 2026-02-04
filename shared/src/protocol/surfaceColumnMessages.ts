/**
 * Surface Column binary messages
 * 
 * Surface columns are an optimization that bundles:
 * 1. A map tile (2D surface summary)
 * 2. All chunks intersecting the surface (terrain + trees/buildings)
 * 
 * This reduces chunk requests dramatically by only loading chunks near the surface
 * instead of requesting a full 3D volume including empty air and solid rock.
 * 
 * SURFACE_COLUMN_REQUEST Binary Layout (Client -> Server):
 * ┌─────────────┬─────────┬──────────────────────────────────────────┐
 * │ Byte Offset │ Type    │ Description                              │
 * ├─────────────┼─────────┼──────────────────────────────────────────┤
 * │ 0           │ uint8   │ MSG_SURFACE_COLUMN_REQUEST (0x0A)        │
 * │ 1-2         │ int16   │ Tile X coordinate (= chunk X)            │
 * │ 3-4         │ int16   │ Tile Z coordinate (= chunk Z)            │
 * └─────────────┴─────────┴──────────────────────────────────────────┘
 * Total: 5 bytes
 * 
 * SURFACE_COLUMN_DATA Binary Layout (Server -> Client):
 * ┌─────────────┬─────────┬──────────────────────────────────────────┐
 * │ Byte Offset │ Type    │ Description                              │
 * ├─────────────┼─────────┼──────────────────────────────────────────┤
 * │ 0           │ uint8   │ MSG_SURFACE_COLUMN_DATA (0x8B)           │
 * │ 1-2         │ int16   │ Tile X coordinate                        │
 * │ 3-4         │ int16   │ Tile Z coordinate                        │
 * │ 5-2052      │ int16[] │ Heights (1024 × int16 = 2048 bytes)      │
 * │ 2053-3076   │ uint8[] │ Materials (1024 × uint8 = 1024 bytes)    │
 * │ 3077        │ uint8   │ Chunk count                              │
 * │ 3078+       │ chunks  │ Chunk data (variable size per chunk)     │
 * └─────────────┴─────────┴──────────────────────────────────────────┘
 * 
 * Each chunk in the array:
 * ┌─────────────┬─────────┬──────────────────────────────────────────┐
 * │ Byte Offset │ Type    │ Description                              │
 * ├─────────────┼─────────┼──────────────────────────────────────────┤
 * │ 0-1         │ int16   │ Chunk Y coordinate                       │
 * │ 2-5         │ uint32  │ Last build sequence                      │
 * │ 6-65541     │ uint16[]│ Voxel data (32768 × uint16 = 65536 bytes)│
 * └─────────────┴─────────┴──────────────────────────────────────────┘
 * Per chunk: 65542 bytes
 */

import { ByteReader, ByteWriter } from '../util/bytes.js';
import { MAP_TILE_PIXELS } from '../maptile/constants.js';
import { VOXELS_PER_CHUNK } from '../voxel/constants.js';
import type { MapTileData } from '../maptile/MapTileData.js';

// ============== Message IDs ==============

export const MSG_SURFACE_COLUMN_REQUEST = 0x0A;
export const MSG_SURFACE_COLUMN_DATA = 0x8B;

// ============== Types ==============

export interface SurfaceColumnRequest {
  tx: number;
  tz: number;
}

export interface SurfaceColumnChunk {
  chunkY: number;
  lastBuildSeq: number;
  voxelData: Uint16Array;
}

export interface SurfaceColumnResponse {
  tx: number;
  tz: number;
  heights: Int16Array;
  materials: Uint8Array;
  chunks: SurfaceColumnChunk[];
}

// ============== Encoding ==============

/**
 * Encode a surface column request
 */
export function encodeSurfaceColumnRequest(request: SurfaceColumnRequest): ArrayBuffer {
  const writer = new ByteWriter(5);
  writer.writeUint8(MSG_SURFACE_COLUMN_REQUEST);
  writer.writeInt16(request.tx);
  writer.writeInt16(request.tz);
  return writer.toArrayBuffer();
}

/**
 * Decode a surface column request
 */
export function decodeSurfaceColumnRequest(reader: ByteReader): SurfaceColumnRequest {
  return {
    tx: reader.readInt16(),
    tz: reader.readInt16(),
  };
}

/**
 * Encode surface column data for network transmission.
 * Includes tile data + all surface-intersecting chunks.
 */
export function encodeSurfaceColumnData(
  tile: MapTileData,
  chunks: Array<{ cy: number; lastBuildSeq: number; data: Uint16Array }>
): ArrayBuffer {
  // Calculate size: msgId(1) + coords(4) + heights(2048) + materials(1024) + count(1) + chunks
  const chunkDataSize = chunks.length * (2 + 4 + VOXELS_PER_CHUNK * 2); // y + seq + voxels
  const totalSize = 1 + 4 + MAP_TILE_PIXELS * 2 + MAP_TILE_PIXELS + 1 + chunkDataSize;
  
  const writer = new ByteWriter(totalSize);
  
  // Message ID
  writer.writeUint8(MSG_SURFACE_COLUMN_DATA);
  
  // Tile coordinates
  writer.writeInt16(tile.tx);
  writer.writeInt16(tile.tz);
  
  // Tile heights
  for (let i = 0; i < MAP_TILE_PIXELS; i++) {
    writer.writeInt16(tile.heights[i]);
  }
  
  // Tile materials
  for (let i = 0; i < MAP_TILE_PIXELS; i++) {
    writer.writeUint8(tile.materials[i]);
  }
  
  // Chunk count
  writer.writeUint8(chunks.length);
  
  // Each chunk
  for (const chunk of chunks) {
    writer.writeInt16(chunk.cy);
    writer.writeUint32(chunk.lastBuildSeq);
    
    // Write voxel data as raw bytes
    const bytes = new Uint8Array(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
    for (let i = 0; i < bytes.length; i++) {
      writer.writeUint8(bytes[i]);
    }
  }
  
  return writer.toArrayBuffer();
}

/**
 * Decode surface column data from network
 */
export function decodeSurfaceColumnData(reader: ByteReader): SurfaceColumnResponse {
  const tx = reader.readInt16();
  const tz = reader.readInt16();
  
  // Read tile heights
  const heights = new Int16Array(MAP_TILE_PIXELS);
  for (let i = 0; i < MAP_TILE_PIXELS; i++) {
    heights[i] = reader.readInt16();
  }
  
  // Read tile materials
  const materials = new Uint8Array(MAP_TILE_PIXELS);
  for (let i = 0; i < MAP_TILE_PIXELS; i++) {
    materials[i] = reader.readUint8();
  }
  
  // Read chunk count
  const chunkCount = reader.readUint8();
  
  // Read each chunk
  const chunks: SurfaceColumnChunk[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const chunkY = reader.readInt16();
    const lastBuildSeq = reader.readUint32();
    
    // Read voxel data
    const voxelData = new Uint16Array(VOXELS_PER_CHUNK);
    const bytes = new Uint8Array(voxelData.buffer);
    for (let j = 0; j < bytes.length; j++) {
      bytes[j] = reader.readUint8();
    }
    
    chunks.push({ chunkY, lastBuildSeq, voxelData });
  }
  
  return { tx, tz, heights, materials, chunks };
}
