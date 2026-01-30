/**
 * Chunk - Holds voxel data for a 32×32×32 section of the world
 * 
 * This is the core data container for voxel terrain, used by both
 * client (rendering) and server (collision, validation, network).
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

// ============== Types ==============

/**
 * Serializable chunk data for network transmission.
 */
export interface ChunkData {
  cx: number;
  cy: number;
  cz: number;
  /** Base64-encoded Uint16Array data */
  data: string;
}

// ============== Chunk Class ==============

/**
 * A chunk of voxel terrain data.
 * Stores 32×32×32 voxels as packed 16-bit values.
 */
export class Chunk {
  /** Chunk coordinates */
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;

  /** Packed voxel data (32×32×32 = 32,768 voxels) */
  readonly data: Uint16Array;

  /** Whether the chunk needs to be remeshed */
  dirty: boolean = true;

  /** Unique key for this chunk's coordinates */
  readonly key: string;

  constructor(cx: number, cy: number, cz: number) {
    this.cx = cx;
    this.cy = cy;
    this.cz = cz;
    this.data = new Uint16Array(VOXELS_PER_CHUNK);
    this.key = chunkKey(cx, cy, cz);
  }

  /**
   * Create a Chunk from serialized ChunkData.
   */
  static fromChunkData(chunkData: ChunkData): Chunk {
    const chunk = new Chunk(chunkData.cx, chunkData.cy, chunkData.cz);
    const binary = atob(chunkData.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    chunk.data.set(new Uint16Array(bytes.buffer));
    return chunk;
  }

  /**
   * Serialize chunk to ChunkData for network transmission.
   */
  toChunkData(): ChunkData {
    const bytes = new Uint8Array(this.data.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return {
      cx: this.cx,
      cy: this.cy,
      cz: this.cz,
      data: btoa(binary),
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
    this.dirty = true;
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
    this.dirty = true;
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
    this.dirty = true;
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
    this.dirty = true;
  }

  /**
   * Get voxel with margin support - samples from neighbors when coordinates
   * are outside the chunk bounds (-1 or 32).
   * 
   * @param x Local X coordinate (-1 to 32)
   * @param y Local Y coordinate (-1 to 32)
   * @param z Local Z coordinate (-1 to 32)
   * @param neighbors Map of chunk keys to Chunk objects
   * @returns Packed voxel value, or 0 if neighbor doesn't exist
   */
  getVoxelWithMargin(x: number, y: number, z: number, neighbors: Map<string, Chunk>): number {
    // Check if within this chunk's bounds
    if (x >= 0 && x < CHUNK_SIZE && y >= 0 && y < CHUNK_SIZE && z >= 0 && z < CHUNK_SIZE) {
      return this.data[voxelIndex(x, y, z)];
    }

    // Calculate which neighbor chunk to sample from
    let ncx = this.cx;
    let ncy = this.cy;
    let ncz = this.cz;
    let nx = x;
    let ny = y;
    let nz = z;

    if (x < 0) {
      ncx -= 1;
      nx = CHUNK_SIZE + x; // e.g., -1 becomes 31
    } else if (x >= CHUNK_SIZE) {
      ncx += 1;
      nx = x - CHUNK_SIZE; // e.g., 32 becomes 0
    }

    if (y < 0) {
      ncy -= 1;
      ny = CHUNK_SIZE + y;
    } else if (y >= CHUNK_SIZE) {
      ncy += 1;
      ny = y - CHUNK_SIZE;
    }

    if (z < 0) {
      ncz -= 1;
      nz = CHUNK_SIZE + z;
    } else if (z >= CHUNK_SIZE) {
      ncz += 1;
      nz = z - CHUNK_SIZE;
    }

    const neighborKey = chunkKey(ncx, ncy, ncz);
    const neighbor = neighbors.get(neighborKey);

    if (!neighbor) {
      // No neighbor chunk loaded - return empty (negative weight)
      return packVoxel(-0.5, 0, 0);
    }

    return neighbor.getVoxel(nx, ny, nz);
  }

  /**
   * Get weight with margin support.
   */
  getWeightWithMargin(x: number, y: number, z: number, neighbors: Map<string, Chunk>): number {
    return getWeight(this.getVoxelWithMargin(x, y, z, neighbors));
  }

  /**
   * Clear the dirty flag (call after meshing).
   */
  clearDirty(): void {
    this.dirty = false;
  }
}
