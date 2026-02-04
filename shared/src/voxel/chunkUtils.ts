/**
 * Chunk utility functions for voxel data analysis.
 * 
 * These functions operate on raw voxel data arrays and are shared
 * between client and server for consistent behavior.
 */

import { CHUNK_SIZE, VOXELS_PER_CHUNK } from './constants.js';
import { isVoxelSolid, getMaterial, voxelIndex } from './voxelData.js';

// ============== Chunk Content Analysis ==============

/**
 * Check if a chunk has any solid content.
 * Returns true as soon as any solid voxel is found.
 * 
 * @param data - The chunk's voxel data array
 * @returns true if chunk contains at least one solid voxel
 */
export function chunkHasContent(data: Uint16Array): boolean {
  for (let i = 0; i < data.length; i++) {
    if (isVoxelSolid(data[i])) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a chunk is completely empty (no solid voxels).
 * 
 * @param data - The chunk's voxel data array
 * @returns true if chunk contains no solid voxels
 */
export function chunkIsEmpty(data: Uint16Array): boolean {
  return !chunkHasContent(data);
}

// ============== Column Scanning ==============

/**
 * Result of scanning a voxel column for surface.
 */
export interface ColumnSurfaceResult {
  /** Height of the surface in local voxel Y coordinates */
  localY: number;
  /** Material ID at the surface */
  material: number;
  /** Whether a surface was found */
  found: boolean;
}

/**
 * Scan a column within a chunk to find the highest solid voxel.
 * Searches from top to bottom, returning the first solid voxel found.
 * 
 * @param data - The chunk's voxel data array
 * @param lx - Local X coordinate (0-31)
 * @param lz - Local Z coordinate (0-31)
 * @returns Surface result with local Y, material, and found flag
 */
export function scanChunkColumn(data: Uint16Array, lx: number, lz: number): ColumnSurfaceResult {
  for (let ly = CHUNK_SIZE - 1; ly >= 0; ly--) {
    const index = voxelIndex(lx, ly, lz);
    const voxel = data[index];
    
    if (isVoxelSolid(voxel)) {
      return {
        localY: ly,
        material: getMaterial(voxel),
        found: true,
      };
    }
  }
  
  return { localY: -1, material: 0, found: false };
}

/**
 * Scan a column across multiple chunks to find the highest surface.
 * Chunks should be provided in any order; they will be sorted internally.
 * 
 * @param chunks - Array of objects with cy and data properties
 * @param lx - Local X coordinate (0-31)
 * @param lz - Local Z coordinate (0-31)
 * @returns Object with global voxel height and material
 */
export function scanMultiChunkColumn(
  chunks: Array<{ cy: number; data: Uint16Array }>,
  lx: number,
  lz: number
): { height: number; material: number } {
  // Sort chunks from highest to lowest
  const sortedChunks = [...chunks].sort((a, b) => b.cy - a.cy);
  
  for (const chunk of sortedChunks) {
    const result = scanChunkColumn(chunk.data, lx, lz);
    if (result.found) {
      return {
        height: chunk.cy * CHUNK_SIZE + result.localY,
        material: result.material,
      };
    }
  }
  
  // No surface found
  return { height: 0, material: 0 };
}

// ============== Height Range Analysis ==============

/**
 * Result of analyzing a height array for chunk ranges.
 */
export interface ChunkRangeResult {
  /** Minimum chunk Y index containing surface */
  minCy: number;
  /** Maximum chunk Y index containing surface */
  maxCy: number;
  /** Minimum height value in the array */
  minHeight: number;
  /** Maximum height value in the array */
  maxHeight: number;
}

/**
 * Compute the chunk Y range from an array of heights.
 * Useful for determining which chunks to load for a tile.
 * 
 * @param heights - Array or typed array of height values (in voxel units)
 * @returns Object with chunk indices and height extremes
 */
export function getChunkRangeFromHeights(heights: ArrayLike<number>): ChunkRangeResult {
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    if (h < minHeight) minHeight = h;
    if (h > maxHeight) maxHeight = h;
  }
  
  // Handle empty or all-zero heights
  if (!isFinite(minHeight)) {
    minHeight = 0;
    maxHeight = 0;
  }
  
  return {
    minCy: Math.floor(minHeight / CHUNK_SIZE),
    maxCy: Math.floor(maxHeight / CHUNK_SIZE),
    minHeight,
    maxHeight,
  };
}

// ============== Chunk Statistics ==============

/**
 * Count the number of solid voxels in a chunk.
 * Useful for debugging and analytics.
 * 
 * @param data - The chunk's voxel data array
 * @returns Number of solid voxels
 */
export function countSolidVoxels(data: Uint16Array): number {
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    if (isVoxelSolid(data[i])) {
      count++;
    }
  }
  return count;
}

/**
 * Get the fill percentage of a chunk (0-100).
 * 
 * @param data - The chunk's voxel data array
 * @returns Percentage of solid voxels (0-100)
 */
export function getChunkFillPercentage(data: Uint16Array): number {
  return (countSolidVoxels(data) / VOXELS_PER_CHUNK) * 100;
}
