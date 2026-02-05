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
 * 
 * OPTIMIZED: Bulk-copies inner 32³ rows with TypedArray operations,
 * only individually samples the ~5,600 margin voxels around the edges.
 */
function expandChunkData(
  chunk: Chunk,
  neighbors: Map<string, Chunk>,
  useTemp: boolean,
  grid: Uint16Array
): void {
  const dataArray = (useTemp && chunk.tempData) ? chunk.tempData : chunk.data;
  const CS = CHUNK_SIZE; // 32
  const CS_SQ = CS * CS; // 1024
  
  // === Phase 1: Bulk-copy inner 32³ block (rows via subarray) ===
  // Inner block occupies grid positions [0..31, 0..31, 0..31] 
  // which maps to grid indices z*GRID_SIZE_SQ + y*GRID_SIZE + x
  // Source data layout: x + y*CS + z*CS_SQ
  for (let z = 0; z < CS; ++z) {
    const gridZBase = z * GRID_SIZE_SQ;
    const dataZBase = z * CS_SQ;
    for (let y = 0; y < CS; ++y) {
      const gridRowStart = gridZBase + y * GRID_SIZE;
      const dataRowStart = dataZBase + y * CS;
      // Copy 32 voxels in one bulk operation
      grid.set(dataArray.subarray(dataRowStart, dataRowStart + CS), gridRowStart);
    }
  }
  
  // === Phase 2: Fill margin voxels (positions where any coord is 32 or 33) ===
  // These are the faces/edges/corners that extend beyond the chunk bounds.
  // We iterate strategically to only touch margin positions.
  
  // Fill z=32..33 slabs (full xy planes)
  for (let z = CS; z < GRID_SIZE; ++z) {
    const gridZBase = z * GRID_SIZE_SQ;
    for (let y = 0; y < GRID_SIZE; ++y) {
      for (let x = 0; x < GRID_SIZE; ++x) {
        grid[gridZBase + y * GRID_SIZE + x] = chunk.getVoxelWithMargin(x, y, z, neighbors, useTemp);
      }
    }
  }
  
  // Fill y=32..33 rows (only z=0..31)
  for (let z = 0; z < CS; ++z) {
    const gridZBase = z * GRID_SIZE_SQ;
    for (let y = CS; y < GRID_SIZE; ++y) {
      const gridRowBase = gridZBase + y * GRID_SIZE;
      for (let x = 0; x < GRID_SIZE; ++x) {
        grid[gridRowBase + x] = chunk.getVoxelWithMargin(x, y, z, neighbors, useTemp);
      }
    }
  }
  
  // Fill x=32..33 columns (only y=0..31, z=0..31)
  for (let z = 0; z < CS; ++z) {
    const gridZBase = z * GRID_SIZE_SQ;
    for (let y = 0; y < CS; ++y) {
      const gridRowBase = gridZBase + y * GRID_SIZE;
      for (let x = CS; x < GRID_SIZE; ++x) {
        grid[gridRowBase + x] = chunk.getVoxelWithMargin(x, y, z, neighbors, useTemp);
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
