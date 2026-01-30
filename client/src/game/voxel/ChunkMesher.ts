/**
 * ChunkMesher - Bridge between Chunk data and SurfaceNet algorithm
 * 
 * This module handles the game-specific logic of extracting voxel data
 * from Chunks and their neighbors, then passing it to the pure SurfaceNet algorithm.
 */

import { CHUNK_SIZE, voxelIndex, getWeight as getWeightFromPacked, chunkKey } from '@worldify/shared';
import { Chunk } from './Chunk.js';
import { meshVoxels, SurfaceNetInput, SurfaceNetOutput } from './SurfaceNet.js';

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
 * Generate a mesh from chunk voxel data using SurfaceNets algorithm.
 * 
 * @param chunk The chunk to mesh
 * @param neighbors Map of neighbor chunks for margin sampling
 * @param useTemp If true, use tempData for preview rendering (defaults to false)
 * @returns SurfaceNet mesh output
 */
export function meshChunk(
  chunk: Chunk,
  neighbors: Map<string, Chunk>,
  useTemp: boolean = false
): SurfaceNetOutput {
  const input = createChunkInput(chunk, neighbors, useTemp);
  return meshVoxels(input);
}
