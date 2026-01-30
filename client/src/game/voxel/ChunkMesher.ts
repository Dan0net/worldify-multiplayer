/**
 * ChunkMesher - Bridge between Chunk data and SurfaceNet algorithm
 * 
 * This module handles the game-specific logic of extracting voxel data
 * from Chunks and their neighbors, then passing it to the pure SurfaceNet algorithm.
 */

import { CHUNK_SIZE, Chunk, voxelIndex, getWeight as getWeightFromPacked, chunkKey, packVoxel } from '@worldify/shared';
import { meshVoxels, SurfaceNetInput, SurfaceNetOutput } from './SurfaceNet.js';

/**
 * Get voxel from neighbor chunk, using tempData if available and useTemp is true.
 * This allows preview meshes to correctly sample neighbor chunks that are also being previewed.
 */
function getNeighborVoxel(
  chunk: Chunk,
  lx: number,
  ly: number,
  lz: number,
  neighbors: Map<string, Chunk>,
  useTemp: boolean
): number {
  // Calculate which neighbor chunk to sample from
  let ncx = chunk.cx;
  let ncy = chunk.cy;
  let ncz = chunk.cz;
  let nx = lx;
  let ny = ly;
  let nz = lz;

  if (lx < 0) {
    ncx -= 1;
    nx = CHUNK_SIZE + lx; // e.g., -1 becomes 31
  } else if (lx >= CHUNK_SIZE) {
    ncx += 1;
    nx = lx - CHUNK_SIZE; // e.g., 32 becomes 0
  }

  if (ly < 0) {
    ncy -= 1;
    ny = CHUNK_SIZE + ly;
  } else if (ly >= CHUNK_SIZE) {
    ncy += 1;
    ny = ly - CHUNK_SIZE;
  }

  if (lz < 0) {
    ncz -= 1;
    nz = CHUNK_SIZE + lz;
  } else if (lz >= CHUNK_SIZE) {
    ncz += 1;
    nz = lz - CHUNK_SIZE;
  }

  const neighborKey = chunkKey(ncx, ncy, ncz);
  const neighbor = neighbors.get(neighborKey);

  if (!neighbor) {
    // No neighbor chunk loaded - return empty (negative weight)
    return packVoxel(-0.5, 0, 0);
  }

  // Use tempData if previewing and neighbor has temp data (also being previewed)
  if (useTemp && neighbor.tempData) {
    return neighbor.tempData[voxelIndex(nx, ny, nz)];
  }

  return neighbor.getVoxel(nx, ny, nz);
}

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

  // Helper to get weight at local coordinates (with margin support)
  const getWeight = (lx: number, ly: number, lz: number): number => {
    if (lx >= 0 && lx < CHUNK_SIZE && ly >= 0 && ly < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) {
      const packed = dataArray[voxelIndex(lx, ly, lz)];
      return getWeightFromPacked(packed);
    }
    // For margin voxels, use neighbor data (tempData if previewing and available)
    const packed = getNeighborVoxel(chunk, lx, ly, lz, neighbors, useTemp);
    return getWeightFromPacked(packed);
  };

  // Helper to get voxel at local coordinates (with margin support)
  const getVoxel = (lx: number, ly: number, lz: number): number => {
    if (lx >= 0 && lx < CHUNK_SIZE && ly >= 0 && ly < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) {
      return dataArray[voxelIndex(lx, ly, lz)];
    }
    // For margin voxels, use neighbor data (tempData if previewing and available)
    return getNeighborVoxel(chunk, lx, ly, lz, neighbors, useTemp);
  };

  return { dims, getWeight, getVoxel };
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
