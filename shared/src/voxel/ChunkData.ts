/**
 * ChunkData - Shared chunk data container for voxel terrain.
 * 
 * This class handles single-chunk voxel data operations, used by both
 * client and server. For client-specific features (temp data, multi-chunk
 * operations), see client/Chunk.ts which extends this class.
 */

import {
  CHUNK_SIZE,
  VOXELS_PER_CHUNK,
  CHUNK_WORLD_SIZE,
} from './constants.js';
import {
  packVoxel,
  getWeight,
  voxelIndex,
  chunkKey,
} from './voxelData.js';

// ============== Serializable Interface ==============

/**
 * Serializable chunk data for network transmission.
 */
export interface SerializedChunkData {
  cx: number;
  cy: number;
  cz: number;
  /** Base64-encoded Uint16Array data */
  data: string;
}

// ============== Encoding Utilities ==============

/**
 * Encode a Uint16Array to base64 string.
 */
export function encodeChunkData(data: Uint16Array): string {
  const bytes = new Uint8Array(data.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decode a base64 string to Uint16Array.
 */
export function decodeChunkData(base64: string): Uint16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Uint16Array(bytes.buffer);
}

// ============== ChunkData Class ==============

/**
 * A chunk of voxel terrain data.
 * Stores 32×32×32 voxels as packed 16-bit values.
 * 
 * This is the shared base class with single-chunk operations.
 * Client extends this with temp data and multi-chunk features.
 */
export class ChunkData {
  /** Chunk coordinates */
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;

  /** Packed voxel data (32×32×32 = 32,768 voxels) */
  readonly data: Uint16Array;

  /** Unique key for this chunk's coordinates */
  readonly key: string;

  /** Last build sequence number (for versioning) */
  lastBuildSeq: number = 0;

  constructor(cx: number, cy: number, cz: number) {
    this.cx = cx;
    this.cy = cy;
    this.cz = cz;
    this.data = new Uint16Array(VOXELS_PER_CHUNK);
    this.key = chunkKey(cx, cy, cz);
  }

  /**
   * Create a ChunkData from serialized data.
   */
  static fromSerialized(serialized: SerializedChunkData): ChunkData {
    const chunk = new ChunkData(serialized.cx, serialized.cy, serialized.cz);
    chunk.data.set(decodeChunkData(serialized.data));
    return chunk;
  }

  /**
   * Serialize chunk for network transmission.
   */
  toSerialized(): SerializedChunkData {
    return {
      cx: this.cx,
      cy: this.cy,
      cz: this.cz,
      data: encodeChunkData(this.data),
    };
  }

  /**
   * Get the world position of this chunk's minimum corner.
   */
  getWorldPosition(): { x: number; y: number; z: number } {
    return {
      x: this.cx * CHUNK_WORLD_SIZE,
      y: this.cy * CHUNK_WORLD_SIZE,
      z: this.cz * CHUNK_WORLD_SIZE,
    };
  }

  /**
   * Get packed voxel value at local coordinates.
   * @param x Local X coordinate (0-31)
   * @param y Local Y coordinate (0-31)
   * @param z Local Z coordinate (0-31)
   */
  getVoxel(x: number, y: number, z: number): number {
    if (x < 0 || x >= CHUNK_SIZE || y < 0 || y >= CHUNK_SIZE || z < 0 || z >= CHUNK_SIZE) {
      return 0;
    }
    return this.data[voxelIndex(x, y, z)];
  }

  /**
   * Set packed voxel value at local coordinates.
   * @param x Local X coordinate (0-31)
   * @param y Local Y coordinate (0-31)
   * @param z Local Z coordinate (0-31)
   * @param value Packed 16-bit voxel value
   */
  setVoxel(x: number, y: number, z: number, value: number): void {
    if (x < 0 || x >= CHUNK_SIZE || y < 0 || y >= CHUNK_SIZE || z < 0 || z >= CHUNK_SIZE) {
      return;
    }
    this.data[voxelIndex(x, y, z)] = value;
  }

  /**
   * Get weight value at local coordinates.
   */
  getWeightAt(x: number, y: number, z: number): number {
    return getWeight(this.getVoxel(x, y, z));
  }

  /**
   * Fill entire chunk with a single voxel value.
   * @param weight Weight value (-0.5 to +0.5)
   * @param material Material ID (0-127)
   * @param light Light level (0-31)
   */
  fill(weight: number, material: number, light: number): void {
    const packed = packVoxel(weight, material, light);
    this.data.fill(packed);
  }

  /**
   * Generate flat terrain at a given surface height.
   * Voxels below surfaceY get positive weight (solid).
   * Voxels above surfaceY get negative weight (empty).
   * The surface voxel gets weight = 0 (surface crossing).
   * 
   * @param surfaceY The Y coordinate in LOCAL voxel space where the surface is
   * @param material Material ID for solid voxels
   * @param light Light level for all voxels
   */
  generateFlat(surfaceY: number, material: number = 0, light: number = 16): void {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let y = 0; y < CHUNK_SIZE; y++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
          // Calculate weight based on distance from surface
          // Positive = solid, Negative = empty
          // Clamp to [-0.5, 0.5] range
          const distFromSurface = surfaceY - y;
          const weight = Math.max(-0.5, Math.min(0.5, distFromSurface * 0.5));
          
          const packed = packVoxel(weight, material, light);
          this.data[voxelIndex(x, y, z)] = packed;
        }
      }
    }
  }

  /**
   * Generate flat terrain at a GLOBAL voxel height.
   * This adjusts for the chunk's Y position in the world.
   * 
   * @param globalSurfaceY The global Y voxel coordinate where the surface is
   * @param material Material ID for solid voxels
   * @param light Light level for all voxels
   */
  generateFlatGlobal(globalSurfaceY: number, material: number = 0, light: number = 16): void {
    // Convert global surface Y to local space for this chunk
    const chunkBaseY = this.cy * CHUNK_SIZE;
    const localSurfaceY = globalSurfaceY - chunkBaseY;
    
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let y = 0; y < CHUNK_SIZE; y++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
          // Calculate distance from surface in local space
          const distFromSurface = localSurfaceY - y;
          const weight = Math.max(-0.5, Math.min(0.5, distFromSurface * 0.5));
          
          const packed = packVoxel(weight, material, light);
          this.data[voxelIndex(x, y, z)] = packed;
        }
      }
    }
  }
}
