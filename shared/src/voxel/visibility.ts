/**
 * Visibility graph computation for chunk culling.
 * 
 * Implements Minecraft-style "Advanced Cave Culling Algorithm":
 * - For each chunk, compute which faces can "see" each other through non-solid voxels
 * - Uses flood fill to find connected empty regions
 * - Stores result as 15 bits (one per face pair)
 */

import {
  CHUNK_SIZE,
  ChunkFace,
  CHUNK_FACE_COUNT,
  VISIBILITY_ALL,
  VISIBILITY_NONE,
} from './constants.js';
import { isVoxelSolid, voxelIndex } from './voxelData.js';

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
  // Ensure faceA < faceB for consistent ordering
  if (faceA > faceB) {
    [faceA, faceB] = [faceB, faceA];
  }
  
  // Formula for combination index: sum of (5-i) for i < faceA, plus (faceB - faceA - 1)
  // Simplified: faceA * (11 - faceA) / 2 + (faceB - faceA - 1)
  return faceA * (11 - faceA) / 2 + (faceB - faceA - 1);
}

/**
 * Check if a face pair is visible in the visibility bits.
 */
export function canSeeThrough(visibilityBits: number, entryFace: ChunkFace, exitFace: ChunkFace): boolean {
  if (entryFace === exitFace) return false; // Can't enter and exit same face
  const bitIndex = getFacePairIndex(entryFace, exitFace);
  return (visibilityBits & (1 << bitIndex)) !== 0;
}

/**
 * Get the opposite face.
 */
export function getOppositeFace(face: ChunkFace): ChunkFace {
  switch (face) {
    case ChunkFace.POS_X: return ChunkFace.NEG_X;
    case ChunkFace.NEG_X: return ChunkFace.POS_X;
    case ChunkFace.POS_Y: return ChunkFace.NEG_Y;
    case ChunkFace.NEG_Y: return ChunkFace.POS_Y;
    case ChunkFace.POS_Z: return ChunkFace.NEG_Z;
    case ChunkFace.NEG_Z: return ChunkFace.POS_Z;
  }
}

// ============== Flood Fill ==============

/** Offsets for 6-connected neighbors */
const NEIGHBOR_OFFSETS = [
  { dx: 1, dy: 0, dz: 0, face: ChunkFace.POS_X },
  { dx: -1, dy: 0, dz: 0, face: ChunkFace.NEG_X },
  { dx: 0, dy: 1, dz: 0, face: ChunkFace.POS_Y },
  { dx: 0, dy: -1, dz: 0, face: ChunkFace.NEG_Y },
  { dx: 0, dy: 0, dz: 1, face: ChunkFace.POS_Z },
  { dx: 0, dy: 0, dz: -1, face: ChunkFace.NEG_Z },
];

/**
 * Compute visibility bits for a chunk via flood fill.
 * 
 * Algorithm:
 * 1. For each non-solid boundary voxel, start a flood fill
 * 2. Track which faces are reached during the fill
 * 3. Connect all reached faces together in the visibility graph
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
  
  // Visited set for flood fill (reused across fills)
  const visited = new Uint8Array(voxelData.length);
  let visitedGeneration = 0;
  
  // Track which face pairs are connected
  let visibilityBits = 0;
  
  // Process each boundary voxel
  for (let boundaryFace = 0; boundaryFace < CHUNK_FACE_COUNT; boundaryFace++) {
    const boundaryVoxels = getBoundaryVoxels(boundaryFace as ChunkFace);
    
    for (const { x, y, z } of boundaryVoxels) {
      const idx = voxelIndex(x, y, z);
      
      // Skip if solid or already visited in a previous fill
      if (isVoxelSolid(voxelData[idx])) continue;
      if (visited[idx] === visitedGeneration + 1) continue;
      
      // Start a new flood fill from this boundary voxel
      visitedGeneration++;
      const reachedFaces = floodFill(voxelData, x, y, z, visited, visitedGeneration);
      
      // Connect all pairs of reached faces
      const faceList = Array.from(reachedFaces);
      for (let i = 0; i < faceList.length; i++) {
        for (let j = i + 1; j < faceList.length; j++) {
          const bitIndex = getFacePairIndex(faceList[i], faceList[j]);
          visibilityBits |= (1 << bitIndex);
        }
      }
    }
  }
  
  return visibilityBits;
}

/**
 * Get all voxel coordinates on a chunk boundary face.
 */
function getBoundaryVoxels(face: ChunkFace): Array<{ x: number; y: number; z: number }> {
  const result: Array<{ x: number; y: number; z: number }> = [];
  const max = CHUNK_SIZE - 1;
  
  switch (face) {
    case ChunkFace.POS_X:
      for (let y = 0; y < CHUNK_SIZE; y++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
          result.push({ x: max, y, z });
        }
      }
      break;
    case ChunkFace.NEG_X:
      for (let y = 0; y < CHUNK_SIZE; y++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
          result.push({ x: 0, y, z });
        }
      }
      break;
    case ChunkFace.POS_Y:
      for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
          result.push({ x, y: max, z });
        }
      }
      break;
    case ChunkFace.NEG_Y:
      for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
          result.push({ x, y: 0, z });
        }
      }
      break;
    case ChunkFace.POS_Z:
      for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let y = 0; y < CHUNK_SIZE; y++) {
          result.push({ x, y, z: max });
        }
      }
      break;
    case ChunkFace.NEG_Z:
      for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let y = 0; y < CHUNK_SIZE; y++) {
          result.push({ x, y, z: 0 });
        }
      }
      break;
  }
  
  return result;
}

/**
 * Flood fill from a starting voxel, returning which boundary faces are reached.
 * Uses iterative BFS to avoid stack overflow.
 */
function floodFill(
  voxelData: Uint16Array,
  startX: number,
  startY: number,
  startZ: number,
  visited: Uint8Array,
  generation: number
): Set<ChunkFace> {
  const reachedFaces = new Set<ChunkFace>();
  const queue: Array<{ x: number; y: number; z: number }> = [{ x: startX, y: startY, z: startZ }];
  let queueHead = 0; // Use index instead of shift() for performance
  const max = CHUNK_SIZE - 1;
  
  visited[voxelIndex(startX, startY, startZ)] = generation;
  
  while (queueHead < queue.length) {
    const { x, y, z } = queue[queueHead++];
    
    // Check if we're at a boundary
    if (x === 0) reachedFaces.add(ChunkFace.NEG_X);
    if (x === max) reachedFaces.add(ChunkFace.POS_X);
    if (y === 0) reachedFaces.add(ChunkFace.NEG_Y);
    if (y === max) reachedFaces.add(ChunkFace.POS_Y);
    if (z === 0) reachedFaces.add(ChunkFace.NEG_Z);
    if (z === max) reachedFaces.add(ChunkFace.POS_Z);
    
    // Early exit if all faces reached
    if (reachedFaces.size === CHUNK_FACE_COUNT) return reachedFaces;
    
    // Explore neighbors
    for (const { dx, dy, dz } of NEIGHBOR_OFFSETS) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      
      // Bounds check
      if (nx < 0 || nx >= CHUNK_SIZE || ny < 0 || ny >= CHUNK_SIZE || nz < 0 || nz >= CHUNK_SIZE) {
        continue;
      }
      
      const nidx = voxelIndex(nx, ny, nz);
      
      // Skip if already visited or solid
      if (visited[nidx] === generation) continue;
      if (isVoxelSolid(voxelData[nidx])) continue;
      
      visited[nidx] = generation;
      queue.push({ x: nx, y: ny, z: nz });
    }
  }
  
  return reachedFaces;
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
