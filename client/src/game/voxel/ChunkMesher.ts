/**
 * ChunkMesher - Bridge between Chunk data and SurfaceNet algorithm
 * 
 * This module handles the game-specific logic of extracting voxel data
 * from Chunks and their neighbors, then passing it to the pure SurfaceNet algorithm.
 * 
 * OPTIMIZATION: Pre-expands chunk data with margins into a flat array,
 * then passes it directly to SurfaceNet for cache-efficient access.
 * 
 * Two paths:
 * - expandChunkToGrid(): Fills a grid buffer for worker dispatch (main thread only does expansion)
 * - meshChunk(): Sync fallback — expand + SurfaceNet in one call (used by remeshAllDirty, etc.)
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

// Reusable expanded grid buffer for sync path (avoids allocation per chunk)
let syncGrid: Uint16Array | null = null;

function getSyncGrid(): Uint16Array {
  if (!syncGrid) {
    syncGrid = new Uint16Array(GRID_SIZE * GRID_SIZE * GRID_SIZE);
  }
  return syncGrid;
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
  for (let z = 0; z < CS; ++z) {
    const gridZBase = z * GRID_SIZE_SQ;
    const dataZBase = z * CS_SQ;
    for (let y = 0; y < CS; ++y) {
      const gridRowStart = gridZBase + y * GRID_SIZE;
      const dataRowStart = dataZBase + y * CS;
      grid.set(dataArray.subarray(dataRowStart, dataRowStart + CS), gridRowStart);
    }
  }
  
  // === Phase 2: Fill margin voxels (positions where any coord is 32 or 33) ===
  
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
 * Compute skipHighBoundary flags for a chunk.
 */
function getSkipHighBoundary(
  chunk: Chunk,
  neighbors: Map<string, Chunk>,
): [boolean, boolean, boolean] {
  return [
    !neighbors.has(chunkKey(chunk.cx + 1, chunk.cy, chunk.cz)),     // +X
    !neighbors.has(chunkKey(chunk.cx, chunk.cy + 1, chunk.cz)),     // +Y  
    !neighbors.has(chunkKey(chunk.cx, chunk.cy, chunk.cz + 1)),     // +Z
  ];
}

/**
 * Expand chunk data into a provided grid buffer for worker dispatch.
 * Main thread fills the grid, then transfers it to a worker for SurfaceNet.
 * 
 * @param chunk The chunk to expand
 * @param neighbors Map of neighbor chunks for margin sampling
 * @param grid Grid buffer to fill (from MeshWorkerPool.takeGrid())
 * @param useTemp If true, use tempData for preview rendering
 * @returns skipHighBoundary flags for the worker
 */
export function expandChunkToGrid(
  chunk: Chunk,
  neighbors: Map<string, Chunk>,
  grid: Uint16Array,
  useTemp: boolean = false,
): [boolean, boolean, boolean] {
  expandChunkData(chunk, neighbors, useTemp, grid);
  return getSkipHighBoundary(chunk, neighbors);
}

/**
 * Generate meshes for a chunk synchronously (expand + SurfaceNet in one call).
 * Used as fallback by remeshAllDirty() and other sync paths.
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
  const grid = getSyncGrid();
  expandChunkData(chunk, neighbors, useTemp, grid);
  const skipHighBoundary = getSkipHighBoundary(chunk, neighbors);

  const input: SurfaceNetInput = { 
    dims: [GRID_SIZE, GRID_SIZE, GRID_SIZE], 
    data: grid,
    skipHighBoundary,
  };
  return meshVoxelsSplit(input);
}
