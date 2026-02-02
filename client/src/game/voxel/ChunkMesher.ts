/**
 * ChunkMesher - Bridge between Chunk data and SurfaceNet algorithm
 * 
 * This module handles the game-specific logic of extracting voxel data
 * from Chunks and their neighbors, then passing it to the pure SurfaceNet algorithm.
 * 
 * OPTIMIZATION: Pre-expands chunk data with margins into a flat array,
 * then passes it directly to SurfaceNet for cache-efficient access.
 */

import { 
  CHUNK_SIZE, 
  voxelIndex, 
  chunkKey,
} from '@worldify/shared';
import { Chunk } from './Chunk.js';
import { meshVoxelsSplit, SurfaceNetInput, SplitSurfaceNetOutput } from './SurfaceNet.js';

// Re-export types for convenience
export type { SplitSurfaceNetOutput as ChunkMeshOutput };

// Grid dimensions with +2 margin for neighbor stitching
const GRID_SIZE = CHUNK_SIZE + 2; // 34
const GRID_SIZE_SQ = GRID_SIZE * GRID_SIZE; // 1156

// Reusable expanded grid buffer (avoids allocation per chunk)
// Size: 34 * 34 * 34 = 39,304 entries
let expandedGrid: Uint16Array | null = null;

function getExpandedGrid(): Uint16Array {
  if (!expandedGrid) {
    expandedGrid = new Uint16Array(GRID_SIZE * GRID_SIZE * GRID_SIZE);
  }
  return expandedGrid;
}

/**
 * Expand chunk data with margins into a flat 34x34x34 grid.
 * This allows direct index arithmetic in the SurfaceNet hot loop.
 */
function expandChunkData(
  chunk: Chunk,
  neighbors: Map<string, Chunk>,
  useTemp: boolean,
  grid: Uint16Array
): void {
  const dataArray = (useTemp && chunk.tempData) ? chunk.tempData : chunk.data;
  
  // Fill the grid - iterate over all 34x34x34 positions
  for (let z = 0; z < GRID_SIZE; ++z) {
    const lz = z; // local z in -0 to 33 range (we offset later)
    for (let y = 0; y < GRID_SIZE; ++y) {
      const ly = y;
      for (let x = 0; x < GRID_SIZE; ++x) {
        const lx = x;
        const gridIdx = z * GRID_SIZE_SQ + y * GRID_SIZE + x;
        
        // Check if within main chunk bounds (0-31)
        if (lx < CHUNK_SIZE && ly < CHUNK_SIZE && lz < CHUNK_SIZE) {
          grid[gridIdx] = dataArray[voxelIndex(lx, ly, lz)];
        } else {
          // Margin voxel - sample from neighbor
          grid[gridIdx] = chunk.getVoxelWithMargin(lx, ly, lz, neighbors, useTemp);
        }
      }
    }
  }
}

/**
 * Create a SurfaceNetInput from a chunk and its neighbors.
 * Pre-expands data into a flat grid for cache-efficient access.
 */
function createChunkInput(
  chunk: Chunk,
  neighbors: Map<string, Chunk>,
  useTemp: boolean
): SurfaceNetInput {
  const grid = getExpandedGrid();
  expandChunkData(chunk, neighbors, useTemp, grid);

  // Check which +X, +Y, +Z neighbors are missing - skip faces at those high boundaries
  const skipHighBoundary: [boolean, boolean, boolean] = [
    !neighbors.has(chunkKey(chunk.cx + 1, chunk.cy, chunk.cz)),     // +X
    !neighbors.has(chunkKey(chunk.cx, chunk.cy + 1, chunk.cz)),     // +Y  
    !neighbors.has(chunkKey(chunk.cx, chunk.cy, chunk.cz + 1)),     // +Z
  ];

  return { 
    dims: [GRID_SIZE, GRID_SIZE, GRID_SIZE], 
    data: grid,
    skipHighBoundary 
  };
}

/**
 * Generate meshes for a chunk, separated by material type.
 * 
 * OPTIMIZED: Pre-expands chunk data with margins, then uses direct
 * array access in the SurfaceNet algorithm for maximum performance.
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
