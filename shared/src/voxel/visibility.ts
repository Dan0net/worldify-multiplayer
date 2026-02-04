/**
 * Visibility graph computation for chunk culling.
 * 
 * Implements Minecraft-style "Advanced Cave Culling Algorithm":
 * - For each chunk, compute which faces can "see" each other through non-solid voxels
 * - Uses flood fill to find connected empty regions
 * - Stores result as 15 bits (one per face pair)
 * 
 * OPTIMIZED: Zero allocations during computation.
 * - All buffers are pre-allocated at module level
 * - Uses flat indices instead of {x,y,z} objects
 * - Pre-computed lookup tables for boundary detection
 */

import {
  CHUNK_SIZE,
  ChunkFace,
  CHUNK_FACE_COUNT,
  VISIBILITY_ALL,
  VISIBILITY_NONE,
} from './constants.js';
import { isVoxelSolid } from './voxelData.js';

// ============== Pre-allocated Buffers ==============
// All computation uses these module-level arrays - zero allocations per call

/** Total voxels per chunk */
const VOXELS = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE;

/** Queue for BFS flood fill (stores flat indices) */
const queue = new Int32Array(VOXELS);

/** Visited markers - generation-based to avoid clearing */
const visited = new Uint8Array(VOXELS);

/** Current generation for visited tracking */
let visitedGeneration = 0;

/** Stride for Y axis in flat index */
const STRIDE_Y = CHUNK_SIZE;

/** Stride for Z axis in flat index */
const STRIDE_Z = CHUNK_SIZE * CHUNK_SIZE;

/** Neighbor offsets as flat index deltas: [+X, -X, +Y, -Y, +Z, -Z] */
const NEIGHBOR_DELTAS = new Int32Array([1, -1, STRIDE_Y, -STRIDE_Y, STRIDE_Z, -STRIDE_Z]);

/** Max coordinate value */
const MAX_COORD = CHUNK_SIZE - 1;

// ============== Pre-computed Boundary Tables ==============
// For each voxel index, which boundary faces it touches (as a 6-bit mask)

/** Boundary face mask for each voxel index */
const BOUNDARY_MASK = new Uint8Array(VOXELS);

// Face bits: POS_X=1, NEG_X=2, POS_Y=4, NEG_Y=8, POS_Z=16, NEG_Z=32
const FACE_BIT_POS_X = 1 << ChunkFace.POS_X;
const FACE_BIT_NEG_X = 1 << ChunkFace.NEG_X;
const FACE_BIT_POS_Y = 1 << ChunkFace.POS_Y;
const FACE_BIT_NEG_Y = 1 << ChunkFace.NEG_Y;
const FACE_BIT_POS_Z = 1 << ChunkFace.POS_Z;
const FACE_BIT_NEG_Z = 1 << ChunkFace.NEG_Z;

/** Pre-computed starting indices for each boundary face */
const BOUNDARY_STARTS: Int32Array[] = new Array(6);

// Initialize boundary lookup tables
(function initBoundaryTables() {
  // Build boundary mask for each voxel
  for (let z = 0; z < CHUNK_SIZE; z++) {
    for (let y = 0; y < CHUNK_SIZE; y++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const idx = x + y * STRIDE_Y + z * STRIDE_Z;
        let mask = 0;
        if (x === MAX_COORD) mask |= FACE_BIT_POS_X;
        if (x === 0) mask |= FACE_BIT_NEG_X;
        if (y === MAX_COORD) mask |= FACE_BIT_POS_Y;
        if (y === 0) mask |= FACE_BIT_NEG_Y;
        if (z === MAX_COORD) mask |= FACE_BIT_POS_Z;
        if (z === 0) mask |= FACE_BIT_NEG_Z;
        BOUNDARY_MASK[idx] = mask;
      }
    }
  }
  
  // Build boundary start indices for each face
  const faceSize = CHUNK_SIZE * CHUNK_SIZE;
  
  // POS_X: x = MAX_COORD
  BOUNDARY_STARTS[ChunkFace.POS_X] = new Int32Array(faceSize);
  for (let z = 0; z < CHUNK_SIZE; z++) {
    for (let y = 0; y < CHUNK_SIZE; y++) {
      BOUNDARY_STARTS[ChunkFace.POS_X][z * CHUNK_SIZE + y] = MAX_COORD + y * STRIDE_Y + z * STRIDE_Z;
    }
  }
  
  // NEG_X: x = 0
  BOUNDARY_STARTS[ChunkFace.NEG_X] = new Int32Array(faceSize);
  for (let z = 0; z < CHUNK_SIZE; z++) {
    for (let y = 0; y < CHUNK_SIZE; y++) {
      BOUNDARY_STARTS[ChunkFace.NEG_X][z * CHUNK_SIZE + y] = y * STRIDE_Y + z * STRIDE_Z;
    }
  }
  
  // POS_Y: y = MAX_COORD
  BOUNDARY_STARTS[ChunkFace.POS_Y] = new Int32Array(faceSize);
  for (let z = 0; z < CHUNK_SIZE; z++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      BOUNDARY_STARTS[ChunkFace.POS_Y][z * CHUNK_SIZE + x] = x + MAX_COORD * STRIDE_Y + z * STRIDE_Z;
    }
  }
  
  // NEG_Y: y = 0
  BOUNDARY_STARTS[ChunkFace.NEG_Y] = new Int32Array(faceSize);
  for (let z = 0; z < CHUNK_SIZE; z++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      BOUNDARY_STARTS[ChunkFace.NEG_Y][z * CHUNK_SIZE + x] = x + z * STRIDE_Z;
    }
  }
  
  // POS_Z: z = MAX_COORD
  BOUNDARY_STARTS[ChunkFace.POS_Z] = new Int32Array(faceSize);
  for (let y = 0; y < CHUNK_SIZE; y++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      BOUNDARY_STARTS[ChunkFace.POS_Z][y * CHUNK_SIZE + x] = x + y * STRIDE_Y + MAX_COORD * STRIDE_Z;
    }
  }
  
  // NEG_Z: z = 0
  BOUNDARY_STARTS[ChunkFace.NEG_Z] = new Int32Array(faceSize);
  for (let y = 0; y < CHUNK_SIZE; y++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      BOUNDARY_STARTS[ChunkFace.NEG_Z][y * CHUNK_SIZE + x] = x + y * STRIDE_Y;
    }
  }
})();

// ============== Pre-computed Bounds Check Tables ==============
// For each direction, which coordinates would go out of bounds

/** For each voxel, which neighbor directions are valid (6-bit mask) */
const VALID_NEIGHBORS = new Uint8Array(VOXELS);

// Direction bits: +X=1, -X=2, +Y=4, -Y=8, +Z=16, -Z=32
(function initValidNeighbors() {
  for (let z = 0; z < CHUNK_SIZE; z++) {
    for (let y = 0; y < CHUNK_SIZE; y++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const idx = x + y * STRIDE_Y + z * STRIDE_Z;
        let mask = 0x3F; // All 6 directions initially valid
        if (x === MAX_COORD) mask &= ~1;  // No +X
        if (x === 0) mask &= ~2;          // No -X
        if (y === MAX_COORD) mask &= ~4;  // No +Y
        if (y === 0) mask &= ~8;          // No -Y
        if (z === MAX_COORD) mask &= ~16; // No +Z
        if (z === 0) mask &= ~32;         // No -Z
        VALID_NEIGHBORS[idx] = mask;
      }
    }
  }
})();

// ============== Face Pair Lookup Table ==============
// Pre-computed bit positions for all face pairs

/** Bit position for each face pair [faceA * 6 + faceB] */
const FACE_PAIR_BITS = new Uint8Array(36);

(function initFacePairBits() {
  for (let a = 0; a < 6; a++) {
    for (let b = 0; b < 6; b++) {
      if (a === b) {
        FACE_PAIR_BITS[a * 6 + b] = 255; // Invalid - same face
      } else {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        // Formula: lo * (11 - lo) / 2 + (hi - lo - 1)
        FACE_PAIR_BITS[a * 6 + b] = lo * (11 - lo) / 2 + (hi - lo - 1);
      }
    }
  }
})();

// ============== Face Pair Encoding ==============

/**
 * Get the bit index for a face pair (order-independent).
 * Face pairs are encoded as: (0,1), (0,2), (0,3), (0,4), (0,5), (1,2), (1,3), ...
 * 
 * @param faceA - First face index (0-5)
 * @param faceB - Second face index (0-5)
 * @returns Bit index (0-14) for this face pair
 */
export function getFacePairIndex(faceA: ChunkFace, faceB: ChunkFace): number {
  return FACE_PAIR_BITS[faceA * 6 + faceB];
}

/**
 * Check if a face pair is visible in the visibility bits.
 */
export function canSeeThrough(visibilityBits: number, entryFace: ChunkFace, exitFace: ChunkFace): boolean {
  if (entryFace === exitFace) return false; // Can't enter and exit same face
  const bitIndex = FACE_PAIR_BITS[entryFace * 6 + exitFace];
  return (visibilityBits & (1 << bitIndex)) !== 0;
}

/**
 * Get the opposite face.
 */
export function getOppositeFace(face: ChunkFace): ChunkFace {
  // XOR with 1 flips between pairs: 0<->1, 2<->3, 4<->5
  return face ^ 1;
}

// ============== Optimized Flood Fill ==============

/**
 * Compute visibility bits for a chunk via flood fill.
 * 
 * OPTIMIZED: Zero allocations during computation.
 * - Pre-allocated queue and visited arrays
 * - Flat indices instead of {x,y,z} objects  
 * - Pre-computed boundary and neighbor tables
 * - Bit masks for reached faces
 * 
 * @param voxelData - The chunk's voxel data (Uint16Array)
 * @returns 15-bit visibility mask
 */
export function computeVisibility(voxelData: Uint16Array): number {
  // Quick check: if all solid or all empty, return early
  let hasSolid = false;
  let hasEmpty = false;
  
  for (let i = 0; i < voxelData.length; i++) {
    if (isVoxelSolid(voxelData[i])) {
      hasSolid = true;
    } else {
      hasEmpty = true;
    }
    if (hasSolid && hasEmpty) break;
  }
  
  if (!hasEmpty) return VISIBILITY_NONE; // All solid
  if (!hasSolid) return VISIBILITY_ALL;  // All empty (all faces connect)
  
  // Single generation for this entire computation
  // Reset if would overflow
  if (visitedGeneration >= 254) {
    visited.fill(0);
    visitedGeneration = 0;
  }
  visitedGeneration++;
  const gen = visitedGeneration;
  
  let visibilityBits = 0;
  const faceSize = CHUNK_SIZE * CHUNK_SIZE;
  
  // Process each boundary face - find connected regions
  for (let face = 0; face < CHUNK_FACE_COUNT; face++) {
    const boundaryIndices = BOUNDARY_STARTS[face];
    
    for (let i = 0; i < faceSize; i++) {
      const startIdx = boundaryIndices[i];
      
      // Skip if solid or already visited in THIS computation
      if (isVoxelSolid(voxelData[startIdx])) continue;
      if (visited[startIdx] === gen) continue;
      
      // Flood fill using pre-allocated queue
      let queueHead = 0;
      let queueTail = 0;
      queue[queueTail++] = startIdx;
      visited[startIdx] = gen;
      
      // Track which faces are reached (6-bit mask)
      let reachedFaces = 0;
      
      while (queueHead < queueTail) {
        const idx = queue[queueHead++];
        
        // Check boundary membership using pre-computed table
        reachedFaces |= BOUNDARY_MASK[idx];
        
        // Explore valid neighbors using pre-computed table
        const validDirs = VALID_NEIGHBORS[idx];
        
        for (let d = 0; d < 6; d++) {
          if (!(validDirs & (1 << d))) continue;
          
          const neighborIdx = idx + NEIGHBOR_DELTAS[d];
          
          // Skip if already visited or solid
          if (visited[neighborIdx] === gen) continue;
          if (isVoxelSolid(voxelData[neighborIdx])) continue;
          
          visited[neighborIdx] = gen;
          queue[queueTail++] = neighborIdx;
        }
      }
      
      // Convert reached faces mask to visibility bits
      // For each pair of reached faces, set the corresponding bit
      if (reachedFaces !== 0) {
        // Extract face indices from bit mask and connect pairs
        for (let fA = 0; fA < 5; fA++) {
          if (!(reachedFaces & (1 << fA))) continue;
          for (let fB = fA + 1; fB < 6; fB++) {
            if (!(reachedFaces & (1 << fB))) continue;
            const pairBit = FACE_PAIR_BITS[fA * 6 + fB];
            visibilityBits |= (1 << pairBit);
          }
        }
      }
      
      // Early exit if already fully visible
      if (visibilityBits === VISIBILITY_ALL) return visibilityBits;
    }
  }
  
  return visibilityBits;
}

// ============== Face Direction Helpers ==============

/**
 * Get the face normal as a unit vector.
 */
export function getFaceNormal(face: ChunkFace): { x: number; y: number; z: number } {
  switch (face) {
    case ChunkFace.POS_X: return { x: 1, y: 0, z: 0 };
    case ChunkFace.NEG_X: return { x: -1, y: 0, z: 0 };
    case ChunkFace.POS_Y: return { x: 0, y: 1, z: 0 };
    case ChunkFace.NEG_Y: return { x: 0, y: -1, z: 0 };
    case ChunkFace.POS_Z: return { x: 0, y: 0, z: 1 };
    case ChunkFace.NEG_Z: return { x: 0, y: 0, z: -1 };
  }
}

/**
 * Get the neighbor chunk offset for a face.
 */
export function getFaceNeighborOffset(face: ChunkFace): { dx: number; dy: number; dz: number } {
  const normal = getFaceNormal(face);
  return { dx: normal.x, dy: normal.y, dz: normal.z };
}
