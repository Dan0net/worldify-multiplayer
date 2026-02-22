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
  GRID_SIZE,
  chunkKey,
  voxelIndex,
} from '@worldify/shared';
import { Chunk } from './Chunk.js';
import { meshVoxelsSplit, SurfaceNetInput, SplitSurfaceNetOutput } from './SurfaceNet.js';

// Re-export types for convenience
export type { SplitSurfaceNetOutput as ChunkMeshOutput };

// Derived grid constants
const GRID_SIZE_SQ = GRID_SIZE * GRID_SIZE; // 1156
const CS = CHUNK_SIZE;                       // 32
const CS_SQ = CS * CS;                       // 1024

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
 * OPTIMIZED: Bulk-copies inner 32³ rows, then fills the high-side margin
 * (+X, +Y, +Z) by looking up the 7 neighbor data arrays once (3 face,
 * 3 edge, 1 corner) and reading directly via voxelIndex. Avoids per-voxel
 * chunkKey string allocation and Map lookups (~6,500 → 7).
 */
function expandChunkData(
  chunk: Chunk,
  neighbors: Map<string, Chunk>,
  useTemp: boolean,
  grid: Uint16Array
): void {
  const dataArray = (useTemp && chunk.tempData) ? chunk.tempData : chunk.data;
  
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
  
  // === Phase 2: Look up the 7 high-side neighbor data arrays once ===
  const cx = chunk.cx, cy = chunk.cy, cz = chunk.cz;
  const getNeighborData = (ncx: number, ncy: number, ncz: number): Uint16Array | null => {
    const n = neighbors.get(chunkKey(ncx, ncy, ncz));
    if (!n) return null;
    return (useTemp && n.tempData) ? n.tempData : n.data;
  };

  // Face neighbors
  const nPX  = getNeighborData(cx + 1, cy,     cz);     // +X face
  const nPY  = getNeighborData(cx,     cy + 1, cz);     // +Y face
  const nPZ  = getNeighborData(cx,     cy,     cz + 1); // +Z face
  // Edge neighbors (pair of high axes)
  const nPXY = getNeighborData(cx + 1, cy + 1, cz);     // +X+Y edge
  const nPXZ = getNeighborData(cx + 1, cy,     cz + 1); // +X+Z edge
  const nPYZ = getNeighborData(cx,     cy + 1, cz + 1); // +Y+Z edge
  // Corner neighbor
  const nPXYZ = getNeighborData(cx + 1, cy + 1, cz + 1); // +X+Y+Z corner

  // Helper: read a margin voxel by determining which neighbor owns it.
  // mx, my, mz are in the range [0..33] with at least one ≥ 32.
  // Each overflowed axis maps to the neighbor; non-overflowed axes use the local coord.
  const readMarginVoxel = (mx: number, my: number, mz: number): number => {
    const ox = mx >= CS;  // overflows into +X neighbor?
    const oy = my >= CS;  // overflows into +Y neighbor?
    const oz = mz >= CS;  // overflows into +Z neighbor?
    // Local coords in the target chunk
    const lx = ox ? mx - CS : mx;
    const ly = oy ? my - CS : my;
    const lz = oz ? mz - CS : mz;

    let src: Uint16Array | null;
    if (ox && oy && oz) {
      src = nPXYZ;
    } else if (ox && oy) {
      src = nPXY;
    } else if (ox && oz) {
      src = nPXZ;
    } else if (oy && oz) {
      src = nPYZ;
    } else if (ox) {
      src = nPX;
    } else if (oy) {
      src = nPY;
    } else {
      src = nPZ; // oz must be true
    }

    if (src) {
      return src[voxelIndex(lx, ly, lz)];
    }

    // No neighbor loaded — extrapolate from nearest edge voxel in this chunk
    const clampedX = ox ? CS - 1 : mx;
    const clampedY = oy ? CS - 1 : my;
    const clampedZ = oz ? CS - 1 : mz;
    return dataArray[voxelIndex(clampedX, clampedY, clampedZ)];
  };
  
  // === Phase 2a: Fill z=32..33 slabs (full xy planes) ===
  for (let z = CS; z < GRID_SIZE; ++z) {
    const gridZBase = z * GRID_SIZE_SQ;
    // Inner part where x<32 and y<32 — reads from +Z face neighbor only
    for (let y = 0; y < CS; ++y) {
      const gridRowBase = gridZBase + y * GRID_SIZE;
      if (nPZ) {
        const nz = z - CS;
        const srcStart = voxelIndex(0, y, nz);
        grid.set(nPZ.subarray(srcStart, srcStart + CS), gridRowBase);
      } else {
        // Extrapolate: repeat z=31 row from this chunk
        const srcStart = voxelIndex(0, y, CS - 1);
        grid.set(dataArray.subarray(srcStart, srcStart + CS), gridRowBase);
      }
      // x=32..33 in this row (y<32, z>=32) — edge/corner voxels
      for (let x = CS; x < GRID_SIZE; ++x) {
        grid[gridRowBase + x] = readMarginVoxel(x, y, z);
      }
    }
    // y=32..33 rows in this z slab
    for (let y = CS; y < GRID_SIZE; ++y) {
      const gridRowBase = gridZBase + y * GRID_SIZE;
      for (let x = 0; x < GRID_SIZE; ++x) {
        grid[gridRowBase + x] = readMarginVoxel(x, y, z);
      }
    }
  }
  
  // === Phase 2b: Fill y=32..33 rows (only z=0..31) ===
  for (let z = 0; z < CS; ++z) {
    const gridZBase = z * GRID_SIZE_SQ;
    for (let y = CS; y < GRID_SIZE; ++y) {
      const gridRowBase = gridZBase + y * GRID_SIZE;
      // Inner x=0..31 — reads from +Y face neighbor only
      if (nPY) {
        const ny = y - CS;
        const srcStart = voxelIndex(0, ny, z);
        grid.set(nPY.subarray(srcStart, srcStart + CS), gridRowBase);
      } else {
        // Extrapolate: repeat y=31 row from this chunk
        const srcStart = voxelIndex(0, CS - 1, z);
        grid.set(dataArray.subarray(srcStart, srcStart + CS), gridRowBase);
      }
      // x=32..33 columns (y>=32, z<32) — edge voxels
      for (let x = CS; x < GRID_SIZE; ++x) {
        grid[gridRowBase + x] = readMarginVoxel(x, y, z);
      }
    }
  }
  
  // === Phase 2c: Fill x=32..33 columns (only y=0..31, z=0..31) ===
  for (let z = 0; z < CS; ++z) {
    const gridZBase = z * GRID_SIZE_SQ;
    for (let y = 0; y < CS; ++y) {
      const gridRowBase = gridZBase + y * GRID_SIZE;
      // Only 2 voxels per row — reads from +X face neighbor only
      if (nPX) {
        for (let x = CS; x < GRID_SIZE; ++x) {
          grid[gridRowBase + x] = nPX[voxelIndex(x - CS, y, z)];
        }
      } else {
        // Extrapolate: repeat x=31 voxel from this chunk
        const val = dataArray[voxelIndex(CS - 1, y, z)];
        for (let x = CS; x < GRID_SIZE; ++x) {
          grid[gridRowBase + x] = val;
        }
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
