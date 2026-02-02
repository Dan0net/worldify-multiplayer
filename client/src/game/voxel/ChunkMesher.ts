/**
 * ChunkMesher - Bridge between Chunk data and SurfaceNet algorithm
 * 
 * This module handles the game-specific logic of extracting voxel data
 * from Chunks and their neighbors, then passing it to the pure SurfaceNet algorithm.
 */

import { 
  CHUNK_SIZE, 
  voxelIndex, 
  getWeight as getWeightFromPacked, 
  chunkKey,
  MAT_TYPE_SOLID,
  MAT_TYPE_TRANSPARENT,
  MaterialTypeNum,
} from '@worldify/shared';
import { Chunk } from './Chunk.js';
import { meshVoxels, SurfaceNetInput, SurfaceNetOutput } from './SurfaceNet.js';

// Re-export for convenience
export { MAT_TYPE_SOLID, MAT_TYPE_TRANSPARENT };

/**
 * Output from meshing a chunk with material type separation.
 */
export interface ChunkMeshOutput {
  /** Mesh for solid (opaque) materials */
  solid: SurfaceNetOutput;
  /** Mesh for transparent materials (leaves, etc.) */
  transparent: SurfaceNetOutput;
}

/**
 * Create a SurfaceNetInput from a chunk and its neighbors.
 * 
 * @param chunk The chunk to mesh
 * @param neighbors Map of neighbor chunks for boundary stitching
 * @param useTemp If true, use tempData for preview rendering
 * @param materialTypeFilter Optional filter to only include specific material types
 * @returns Input object for the SurfaceNet algorithm
 */
function createChunkInput(
  chunk: Chunk,
  neighbors: Map<string, Chunk>,
  useTemp: boolean,
  materialTypeFilter?: MaterialTypeNum
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

  return { dims, getWeight, getVoxel, skipHighBoundary, materialTypeFilter };
}

/**
 * Generate meshes for a chunk, separated by material type.
 * 
 * This generates two meshes:
 * - solid: Opaque materials rendered with no alpha blending
 * - transparent: Materials with alpha (leaves, etc.) rendered with transparency
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
): ChunkMeshOutput {
  // Generate solid mesh (opaque materials)
  const solidInput = createChunkInput(chunk, neighbors, useTemp, MAT_TYPE_SOLID);
  const solid = meshVoxels(solidInput);
  
  // Generate transparent mesh (leaves, etc.)
  const transparentInput = createChunkInput(chunk, neighbors, useTemp, MAT_TYPE_TRANSPARENT);
  const transparent = meshVoxels(transparentInput);
  
  return { solid, transparent };
}

/**
 * Generate a single mesh from chunk voxel data (all materials).
 * Use this for cases where material type separation is not needed.
 * 
 * @param chunk The chunk to mesh
 * @param neighbors Map of neighbor chunks for margin sampling
 * @param useTemp If true, use tempData for preview rendering (defaults to false)
 * @returns SurfaceNet mesh output (all materials combined)
 */
export function meshChunkSingle(
  chunk: Chunk,
  neighbors: Map<string, Chunk>,
  useTemp: boolean = false
): SurfaceNetOutput {
  const input = createChunkInput(chunk, neighbors, useTemp);
  return meshVoxels(input);
}
