/**
 * Visibility-based BFS traversal for chunk loading and rendering.
 * 
 * Implements Minecraft-style "Advanced Cave Culling Algorithm":
 * - Start from camera chunk
 * - BFS through chunks, checking visibility graph at each step
 * - Only traverse to neighbors if visibility allows
 * - Apply frustum culling and distance limits
 */

import * as THREE from 'three';
import {
  ChunkFace,
  VISIBILITY_RADIUS,
  // CHUNK_WORLD_SIZE,  // Temporarily disabled for debugging
  chunkKey,
  // canSeeThrough,  // Temporarily disabled for debugging
  getOppositeFace,
  // getFaceNormal,  // Temporarily disabled for debugging
  // VISIBILITY_ALL,  // Temporarily disabled for debugging
} from '@worldify/shared';
import type { Chunk } from './Chunk.js';

// ============== Types ==============

export interface VisibilityResult {
  /** Chunks that are visible and should be loaded/rendered */
  visible: Set<string>;
  /** Chunks that need to be requested (visible but not loaded) */
  toRequest: Set<string>;
}

export interface ChunkProvider {
  /** Get a loaded chunk by key */
  getChunkByKey(key: string): Chunk | undefined;
  /** Check if a chunk is pending load */
  isPending(key: string): boolean;
}

// ============== BFS State ==============

interface BFSStep {
  cx: number;
  cy: number;
  cz: number;
  entryFace: ChunkFace | null;  // null for starting chunk
  distance: number;
}

// ============== Face Definitions ==============

const ALL_FACES: ChunkFace[] = [
  ChunkFace.POS_X,
  ChunkFace.NEG_X,
  ChunkFace.POS_Y,
  ChunkFace.NEG_Y,
  ChunkFace.POS_Z,
  ChunkFace.NEG_Z,
];

const FACE_OFFSETS: Record<ChunkFace, { dx: number; dy: number; dz: number }> = {
  [ChunkFace.POS_X]: { dx: 1, dy: 0, dz: 0 },
  [ChunkFace.NEG_X]: { dx: -1, dy: 0, dz: 0 },
  [ChunkFace.POS_Y]: { dx: 0, dy: 1, dz: 0 },
  [ChunkFace.NEG_Y]: { dx: 0, dy: -1, dz: 0 },
  [ChunkFace.POS_Z]: { dx: 0, dy: 0, dz: 1 },
  [ChunkFace.NEG_Z]: { dx: 0, dy: 0, dz: -1 },
};

// ============== Main BFS Function ==============

/**
 * Perform visibility BFS to find all visible chunks from camera position.
 * 
 * @param cameraChunk - The chunk the camera is in
 * @param cameraDir - Normalized camera forward direction
 * @param frustum - Three.js frustum for culling
 * @param chunkProvider - Access to loaded chunks
 * @param maxRadius - Maximum BFS distance (default: VISIBILITY_RADIUS)
 * @returns Set of visible chunk keys and chunks to request
 */
export function getVisibleChunks(
  cameraChunk: { cx: number; cy: number; cz: number },
  _cameraDir: THREE.Vector3,  // Temporarily unused for debugging
  _frustum: THREE.Frustum,    // Temporarily unused for debugging
  chunkProvider: ChunkProvider,
  maxRadius: number = VISIBILITY_RADIUS
): VisibilityResult {
  const visible = new Set<string>();
  const toRequest = new Set<string>();
  const visited = new Set<string>();
  
  const queue: BFSStep[] = [];
  let queueHead = 0; // Use index instead of shift() for performance
  
  // Start from camera chunk
  const startKey = chunkKey(cameraChunk.cx, cameraChunk.cy, cameraChunk.cz);
  queue.push({
    cx: cameraChunk.cx,
    cy: cameraChunk.cy,
    cz: cameraChunk.cz,
    entryFace: null,
    distance: 0,
  });
  visited.add(startKey);
  
  while (queueHead < queue.length) {
    const step = queue[queueHead++];
    const { cx, cy, cz, distance } = step;
    const key = chunkKey(cx, cy, cz);
    
    // Add to visible set
    visible.add(key);
    
    // Check if loaded
    const chunk = chunkProvider.getChunkByKey(key);
    if (!chunk && !chunkProvider.isPending(key)) {
      toRequest.add(key);
    }
    
    // Visibility bits check temporarily disabled for debugging
    // const visibilityBits = chunk?.visibilityBits ?? VISIBILITY_ALL;
    
    // Check each neighbor
    for (const exitFace of ALL_FACES) {
      const offset = FACE_OFFSETS[exitFace];
      const ncx = cx + offset.dx;
      const ncy = cy + offset.dy;
      const ncz = cz + offset.dz;
      const neighborKey = chunkKey(ncx, ncy, ncz);
      
      // Skip if already visited
      if (visited.has(neighborKey)) continue;
      
      // Filter 1: Distance limit
      const newDistance = distance + 1;
      if (newDistance > maxRadius) continue;
      
      // Filter 2: Don't go backward (dot product with camera direction)
      // TEMPORARILY DISABLED for debugging
      // const faceNormal = getFaceNormal(exitFace);
      // const dot = faceNormal.x * cameraDir.x + faceNormal.y * cameraDir.y + faceNormal.z * cameraDir.z;
      // if (dot > 0.5) continue;
      
      // Filter 3: Visibility graph check
      // TEMPORARILY DISABLED for debugging
      // if (entryFace !== null && !canSeeThrough(visibilityBits, entryFace, exitFace)) {
      //   continue;
      // }
      
      // Filter 4: Frustum culling (most expensive, do last)
      // TEMPORARILY DISABLED for debugging
      // const chunkBox = getChunkBoundingBox(ncx, ncy, ncz);
      // if (!frustum.intersectsBox(chunkBox)) continue;
      
      // Passed all filters - queue this neighbor
      visited.add(neighborKey);
      queue.push({
        cx: ncx,
        cy: ncy,
        cz: ncz,
        entryFace: getOppositeFace(exitFace),
        distance: newDistance,
      });
    }
  }
  
  return { visible, toRequest };
}

// ============== Helpers ==============

// NOTE: getChunkBoundingBox temporarily disabled for debugging
// Will be re-enabled when frustum culling is turned back on

/**
 * Create a frustum from a camera.
 */
export function getFrustumFromCamera(camera: THREE.Camera): THREE.Frustum {
  const frustum = new THREE.Frustum();
  const projScreenMatrix = new THREE.Matrix4();
  
  projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projScreenMatrix);
  
  return frustum;
}

/**
 * Get normalized camera direction.
 */
export function getCameraDirection(camera: THREE.Camera): THREE.Vector3 {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  return dir;
}
