/**
 * Chunk - Client-side voxel chunk with rendering and preview support.
 * 
 * Extends ChunkData with client-specific features:
 * - Temp data for preview rendering
 * - Multi-chunk operations (getVoxelWithMargin for neighbor sampling)
 * - Dirty tracking for remeshing
 */

import {
  CHUNK_SIZE,
  VOXELS_PER_CHUNK,
  getWeight,
  voxelIndex,
  chunkKey,
  ChunkData,
  SerializedChunkData,
  decodeChunkData,
} from '@worldify/shared';

/**
 * Client-side chunk with temp data and multi-chunk support.
 * Extends the shared ChunkData class.
 */
export class Chunk extends ChunkData {
  /** Temporary data buffer for preview (not persisted) */
  tempData: Uint16Array | null = null;

  /** Whether the chunk needs to be remeshed */
  dirty: boolean = true;

  constructor(cx: number, cy: number, cz: number) {
    super(cx, cy, cz);
  }

  /**
   * Create a Chunk from serialized ChunkData.
   */
  static fromChunkData(chunkData: SerializedChunkData): Chunk {
    const chunk = new Chunk(chunkData.cx, chunkData.cy, chunkData.cz);
    chunk.data.set(decodeChunkData(chunkData.data));
    return chunk;
  }

  /**
   * Override setVoxel to mark chunk as dirty.
   */
  override setVoxel(x: number, y: number, z: number, value: number): void {
    // Only mark dirty if coordinates are valid (base class will ignore out-of-bounds)
    if (x >= 0 && x < CHUNK_SIZE && y >= 0 && y < CHUNK_SIZE && z >= 0 && z < CHUNK_SIZE) {
      super.setVoxel(x, y, z, value);
      this.dirty = true;
    }
  }

  /**
   * Override fill to mark chunk as dirty.
   */
  override fill(weight: number, material: number, light: number): void {
    super.fill(weight, material, light);
    this.dirty = true;
  }

  /**
   * Override generateFlat to mark chunk as dirty.
   */
  override generateFlat(surfaceY: number, material: number = 0, light: number = 16): void {
    super.generateFlat(surfaceY, material, light);
    this.dirty = true;
  }

  /**
   * Override generateFlatGlobal to mark chunk as dirty.
   */
  override generateFlatGlobal(globalSurfaceY: number, material: number = 0, light: number = 16): void {
    super.generateFlatGlobal(globalSurfaceY, material, light);
    this.dirty = true;
  }

  /**
   * Clear the dirty flag (call after meshing).
   */
  clearDirty(): void {
    this.dirty = false;
  }

  // ============== Multi-Chunk Operations ==============

  /**
   * Get voxel with margin support - samples from neighbors when coordinates
   * are outside the chunk bounds (-1 or 32).
   * 
   * @param x Local X coordinate (-1 to 32)
   * @param y Local Y coordinate (-1 to 32)
   * @param z Local Z coordinate (-1 to 32)
   * @param neighbors Map of chunk keys to Chunk objects
   * @param useTemp If true, prefer tempData over data (for preview rendering)
   * @returns Packed voxel value, or extrapolated value if neighbor doesn't exist
   */
  getVoxelWithMargin(x: number, y: number, z: number, neighbors: Map<string, Chunk>, useTemp: boolean = false): number {
    // Check if within this chunk's bounds
    if (x >= 0 && x < CHUNK_SIZE && y >= 0 && y < CHUNK_SIZE && z >= 0 && z < CHUNK_SIZE) {
      const dataArray = (useTemp && this.tempData) ? this.tempData : this.data;
      return dataArray[voxelIndex(x, y, z)];
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
      // No neighbor chunk loaded - extrapolate from nearest edge voxel in this chunk.
      // This prevents artificial surfaces at chunk margins when edge/corner neighbors 
      // aren't loaded. Clamp coordinates to valid range [0, CHUNK_SIZE-1].
      const clampedX = Math.max(0, Math.min(CHUNK_SIZE - 1, x));
      const clampedY = Math.max(0, Math.min(CHUNK_SIZE - 1, y));
      const clampedZ = Math.max(0, Math.min(CHUNK_SIZE - 1, z));
      const dataArray = (useTemp && this.tempData) ? this.tempData : this.data;
      return dataArray[voxelIndex(clampedX, clampedY, clampedZ)];
    }

    // Use tempData if previewing and neighbor has temp data
    if (useTemp && neighbor.tempData) {
      return neighbor.tempData[voxelIndex(nx, ny, nz)];
    }

    return neighbor.getVoxel(nx, ny, nz);
  }

  /**
   * Get weight with margin support.
   */
  getWeightWithMargin(x: number, y: number, z: number, neighbors: Map<string, Chunk>, useTemp: boolean = false): number {
    return getWeight(this.getVoxelWithMargin(x, y, z, neighbors, useTemp));
  }

  // ============== Temp Data Management ==============

  /**
   * Copy current data to temp buffer (reset preview to current state).
   */

  copyToTemp(): void {
    if (!this.tempData) {
      this.tempData = new Uint16Array(VOXELS_PER_CHUNK);
    }
    this.tempData.set(this.data);
  }

  /**
   * Discard temp data (cancel preview).
   */
  discardTemp(): void {
    this.tempData = null;
  }
}
