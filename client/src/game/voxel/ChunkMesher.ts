/**
 * ChunkMesher - Bridge between Chunk data and SurfaceNet algorithm
 * 
 * This module handles the game-specific logic of extracting voxel data
 * from Chunks and their neighbors, then passing it to the pure SurfaceNet algorithm.
 * 
 * OPTIMIZATION: Uses single-pass mesh generation with face binning.
 * The SurfaceNet traverses the voxel grid once and bins faces by material type.
 */

import { 
  CHUNK_SIZE, 
  voxelIndex, 
  getWeight as getWeightFromPacked, 
  chunkKey,
} from '@worldify/shared';
import { Chunk } from './Chunk.js';
import { meshVoxelsSplit, SurfaceNetInput, SplitSurfaceNetOutput } from './SurfaceNet.js';

// Re-export types for convenience
export type { SplitSurfaceNetOutput as ChunkMeshOutput };

/**
 * Create a SurfaceNetInput from a chunk and its neighbors.
 * 
 * @param chunk The chunk to mesh
 * @param neighbors Map of neighbor chunks for boundary stitching
 * @param useTemp If true, use tempData for preview rendering
 * @returns Input object for the SurfaceNet algorithm
 */
function createChunkInput(
  chunk: Chunk,
  neighbors: Map<string, Chunk>,
  useTemp: boolean
): SurfaceNetInput {
  // Get the data array to use (temp for preview if available, otherwise main)
  const dataArray = (useTemp && chunk.tempData) ? chunk.tempData : chunk.data;

  // Dimensions: CHUNK_SIZE + 2 to iterate up to and including CHUNK_SIZE
  // This allows us to generate vertices at the chunk boundary that stitch with neighbors
  const dims: [number, number, number] = [CHUNK_SIZE + 2, CHUNK_SIZE + 2, CHUNK_SIZE + 2];

  // Check which +X, +Y, +Z neighbors are missing - skip faces at those high boundaries
  const skipHighBoundary: [boolean, boolean, boolean] = [
    !neighbors.has(chunkKey(chunk.cx + 1, chunk.cy, chunk.cz)),     // +X
    !neighbors.has(chunkKey(chunk.cx, chunk.cy + 1, chunk.cz)),     // +Y  
    !neighbors.has(chunkKey(chunk.cx, chunk.cy, chunk.cz + 1)),     // +Z
  ];

  // Helper to get weight at local coordinates (with margin support)
  const getWeight = (lx: number, ly: number, lz: number): number => {
    if (lx >= 0 && lx < CHUNK_SIZE && ly >= 0 && ly < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) {
      const packed = dataArray[voxelIndex(lx, ly, lz)];
      return getWeightFromPacked(packed);
    }
    // For margin voxels, delegate to Chunk's method (handles tempData correctly)
    return chunk.getWeightWithMargin(lx, ly, lz, neighbors, useTemp);
  };

  // Helper to get voxel at local coordinates (with margin support)
  const getVoxel = (lx: number, ly: number, lz: number): number => {
    if (lx >= 0 && lx < CHUNK_SIZE && ly >= 0 && ly < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) {
      return dataArray[voxelIndex(lx, ly, lz)];
    }
    // For margin voxels, delegate to Chunk's method (handles tempData correctly)
    return chunk.getVoxelWithMargin(lx, ly, lz, neighbors, useTemp);
  };

  return { dims, getWeight, getVoxel, skipHighBoundary };
}

/**
 * Generate meshes for a chunk, separated by material type.
 * 
 * SINGLE-PASS: This uses meshVoxelsSplit which traverses the voxel grid once
 * and bins faces by material type. This is 2× faster than generating
 * solid and transparent meshes separately.
 * 
 * @param chunk The chunk to mesh
 * @param neighbors Map of neighbor chunks for margin sampling
 * @param useTemp If true, use tempData for preview rendering (defaults to false)
 * @returns Separate mesh outputs for solid and transparent materials
 */
export function meshChunk(
  chunk: Chunk,
  neighbors: Map<string, Chunk>,
  useTemp: boolean = false
): SplitSurfaceNetOutput {
  const input = createChunkInput(chunk, neighbors, useTemp);
  return meshVoxelsSplit(input);
}
