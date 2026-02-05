/**
 * Visibility-based BFS traversal for chunk loading and rendering.
 * 
 * Implements Minecraft-style "Advanced Cave Culling Algorithm":
 * - Start from camera chunk
 * - BFS through chunks, checking visibility graph at each step
 * - Only traverse to neighbors if visibility allows
 * - Apply frustum culling and distance limits
 * 
 * OPTIMIZED: Zero allocations during traversal.
 * - Pre-allocated typed array queues
 * - Flat index arithmetic instead of objects
 * - Reusable output sets (caller provides)
 */

import * as THREE from 'three';
import {
  VISIBILITY_RADIUS,
  VISIBILITY_ALL,
  chunkKey,
  ChunkFace,
  canSeeThrough,
  getOppositeFace,
} from '@worldify/shared';
import type { Chunk } from './Chunk.js';

// ============== Types ==============

export interface VisibilityResult {
  /** Chunks that are reachable via visibility graph (no frustum culling) */
  reachable: Set<string>;
  /** Chunks that need to be requested (in frustum, reachable, but not loaded) */
  toRequest: Set<string>;
}

export interface ChunkProvider {
  /** Get a loaded chunk by key */
  getChunkByKey(key: string): Chunk | undefined;
  /** Check if a chunk is pending load */
  isPending(key: string): boolean;
}

// ============== Pre-allocated Buffers ==============

/** Grid diameter (radius * 2 + 1) */
const GRID_DIAMETER = VISIBILITY_RADIUS * 2 + 1;

/** Total grid cells */
const GRID_SIZE = GRID_DIAMETER * GRID_DIAMETER * GRID_DIAMETER;

/** Queue for BFS - stores flat grid indices */
const bfsQueue = new Int32Array(GRID_SIZE);

/** Entry face for each queued item (-1 for start chunk = camera) */
const bfsEntryFace = new Int8Array(GRID_SIZE);

/** Visited markers */
const bfsVisited = new Uint8Array(GRID_SIZE);

/** Store visible indices for later conversion */
const visibleIndices = new Int32Array(GRID_SIZE);

/** Store toRequest indices */
const toRequestIndices = new Int32Array(GRID_SIZE);

/** Generation counter for visited tracking */
let bfsGeneration = 0;

/** Grid strides */
const STRIDE_Y = GRID_DIAMETER;
const STRIDE_Z = GRID_DIAMETER * GRID_DIAMETER;

/** Neighbor offsets in grid coords: [+X, -X, +Y, -Y, +Z, -Z] (matches ChunkFace order) */
// Flat array: [dx0, dy0, dz0, dx1, dy1, dz1, ...]
const NEIGHBOR_OFFSETS = new Int8Array([
  1, 0, 0,   // POS_X = 0
  -1, 0, 0,  // NEG_X = 1
  0, 1, 0,   // POS_Y = 2
  0, -1, 0,  // NEG_Y = 3
  0, 0, 1,   // POS_Z = 4
  0, 0, -1,  // NEG_Z = 5
]);

/** Reusable frustum (avoid allocation per frame) */
const reusableFrustum = new THREE.Frustum();
const reusableMatrix = new THREE.Matrix4();
const reusableDir = new THREE.Vector3();

// ============== Helper Functions ==============

/** Convert grid-relative coordinates to flat index */
function gridToIndex(gx: number, gy: number, gz: number): number {
  return gx + gy * STRIDE_Y + gz * STRIDE_Z;
}

/** Check if grid coords are in bounds */
function inBounds(gx: number, gy: number, gz: number): boolean {
  return gx >= 0 && gx < GRID_DIAMETER &&
         gy >= 0 && gy < GRID_DIAMETER &&
         gz >= 0 && gz < GRID_DIAMETER;
}

/** Convert grid index to world chunk coords (writes to out param to avoid allocation) */
function indexToWorldChunk(
  idx: number,
  baseCx: number,
  baseCy: number,
  baseCz: number,
  centerOffset: number
): { cx: number; cy: number; cz: number } {
  const gz = Math.floor(idx / STRIDE_Z);
  const gy = Math.floor((idx % STRIDE_Z) / STRIDE_Y);
  const gx = idx % STRIDE_Y;
  return {
    cx: baseCx + (gx - centerOffset),
    cy: baseCy + (gy - centerOffset),
    cz: baseCz + (gz - centerOffset),
  };
}

// ============== Main BFS Function ==============

/**
 * Perform visibility BFS to find all visible chunks from camera position.
 * 
 * OPTIMIZED: Minimal allocations during BFS.
 * - Uses pre-allocated typed arrays for queue and visited
 * - Only allocates when building final Sets for compatibility
 * 
 * @param cameraChunk - The chunk the camera is in
 * @param cameraDir - Normalized camera forward direction (unused, reserved for future)
 * @param frustum - Three.js frustum for culling visible set
 * @param chunkProvider - Access to loaded chunks
 * @param maxRadius - Maximum BFS distance (default: VISIBILITY_RADIUS)
 * @returns Set of visible chunk keys and chunks to request
 */
export function getVisibleChunks(
  cameraChunk: { cx: number; cy: number; cz: number },
  _cameraDir: THREE.Vector3,  // Reserved for future direction-based culling
  _frustum: THREE.Frustum,
  chunkProvider: ChunkProvider,
  maxRadius: number = VISIBILITY_RADIUS
): VisibilityResult {
  // Reset generation counter if would overflow
  if (bfsGeneration >= 254) {
    bfsVisited.fill(0);
    bfsGeneration = 0;
  }
  bfsGeneration++;
  const gen = bfsGeneration;
  
  // Camera chunk is at center of grid
  const centerOffset = VISIBILITY_RADIUS;
  const { cx: baseCx, cy: baseCy, cz: baseCz } = cameraChunk;
  
  // Track counts
  let visibleCount = 0;
  let toRequestCount = 0;
  
  // Start BFS from center (camera chunk has no entry face = -1, sees all)
  let queueHead = 0;
  let queueTail = 0;
  
  const startIdx = gridToIndex(centerOffset, centerOffset, centerOffset);
  bfsQueue[queueTail] = startIdx;
  bfsEntryFace[queueTail] = -1; // Camera chunk: no entry face
  queueTail++;
  bfsVisited[startIdx] = gen;
  
  while (queueHead < queueTail) {
    const idx = bfsQueue[queueHead];
    const entryFace = bfsEntryFace[queueHead];
    queueHead++;
    
    // Convert grid index back to grid coords
    const gz = Math.floor(idx / STRIDE_Z);
    const gy = Math.floor((idx % STRIDE_Z) / STRIDE_Y);
    const gx = idx % STRIDE_Y;
    
    // Convert to world chunk coords
    const cx = baseCx + (gx - centerOffset);
    const cy = baseCy + (gy - centerOffset);
    const cz = baseCz + (gz - centerOffset);
    
    // Get chunk data for visibility check
    const key = chunkKey(cx, cy, cz);
    const chunk = chunkProvider.getChunkByKey(key);
    
    // Add to visible list (BFS reached it, so it's potentially visible)
    visibleIndices[visibleCount++] = idx;
    
    // Check if chunk needs to be requested
    if (!chunk && !chunkProvider.isPending(key)) {
      toRequestIndices[toRequestCount++] = idx;
    }
    
    // IMPORTANT: Don't traverse through unloaded chunks
    // We request them, but can't know their visibility until loaded
    if (!chunk) continue;
    
    // Get visibility bits (-1 means "not computed yet", treat as all visible)
    const visBits = chunk.visibilityBits;
    const effectiveVisBits = visBits === -1 ? VISIBILITY_ALL : visBits;
    
    // Explore neighbors
    for (let exitFace = 0; exitFace < 6; exitFace++) {
      const offsetBase = exitFace * 3;
      const ngx = gx + NEIGHBOR_OFFSETS[offsetBase];
      const ngy = gy + NEIGHBOR_OFFSETS[offsetBase + 1];
      const ngz = gz + NEIGHBOR_OFFSETS[offsetBase + 2];
      
      // Bounds check
      if (!inBounds(ngx, ngy, ngz)) continue;
      
      const neighborIdx = gridToIndex(ngx, ngy, ngz);
      
      // Skip if already visited
      if (bfsVisited[neighborIdx] === gen) continue;
      
      // Distance check (using grid distance from center)
      const newDist = Math.abs(ngx - centerOffset) + Math.abs(ngy - centerOffset) + Math.abs(ngz - centerOffset);
      if (newDist > maxRadius) continue;
      
      // Visibility check: can we see through from entry face to this exit face?
      // Camera chunk (entryFace = -1) can see all directions
      if (entryFace !== -1 && !canSeeThrough(effectiveVisBits, entryFace as ChunkFace, exitFace as ChunkFace)) {
        continue;
      }
      
      // Calculate entry face for neighbor (opposite of exit face)
      const neighborEntryFace = getOppositeFace(exitFace as ChunkFace);
      
      // Mark visited and queue
      bfsVisited[neighborIdx] = gen;
      bfsQueue[queueTail] = neighborIdx;
      bfsEntryFace[queueTail] = neighborEntryFace;
      queueTail++;
    }
  }
  
  // Build output Sets
  // Reachable: all chunks BFS reached (no frustum - that's done per-frame in VoxelWorld)
  // toRequest: frustum-culled (no point loading behind camera)
  const reachable = new Set<string>();
  const toRequest = new Set<string>();
  
  for (let i = 0; i < visibleCount; i++) {
    const idx = visibleIndices[i];
    const { cx, cy, cz } = indexToWorldChunk(idx, baseCx, baseCy, baseCz, centerOffset);
    reachable.add(chunkKey(cx, cy, cz));
  }
  
  for (let i = 0; i < toRequestCount; i++) {
    const idx = toRequestIndices[i];
    const { cx, cy, cz } = indexToWorldChunk(idx, baseCx, baseCy, baseCz, centerOffset);
    
    // TEMPORARILY DISABLED: Frustum cull requests - no point loading chunks behind camera
    // const worldX = cx * CHUNK_WORLD_SIZE;
    // const worldY = cy * CHUNK_WORLD_SIZE;
    // const worldZ = cz * CHUNK_WORLD_SIZE;
    // tempBox.min.set(worldX, worldY, worldZ);
    // tempBox.max.set(worldX + CHUNK_WORLD_SIZE, worldY + CHUNK_WORLD_SIZE, worldZ + CHUNK_WORLD_SIZE);
    // 
    // if (frustum.intersectsBox(tempBox)) {
    //   toRequest.add(chunkKey(cx, cy, cz));
    // }
    toRequest.add(chunkKey(cx, cy, cz));
  }
  
  return { reachable, toRequest };
}

// ============== Helpers ==============

/**
 * Create a frustum from a camera (reuses pre-allocated objects).
 */
export function getFrustumFromCamera(camera: THREE.Camera): THREE.Frustum {
  reusableMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  reusableFrustum.setFromProjectionMatrix(reusableMatrix);
  return reusableFrustum;
}

/**
 * Get normalized camera direction (reuses pre-allocated vector).
 */
export function getCameraDirection(camera: THREE.Camera): THREE.Vector3 {
  camera.getWorldDirection(reusableDir);
  return reusableDir;
}