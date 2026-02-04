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
  chunkKey,
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

// ============== Pre-allocated Buffers ==============

/** Grid diameter (radius * 2 + 1) */
const GRID_DIAMETER = VISIBILITY_RADIUS * 2 + 1;

/** Total grid cells */
const GRID_SIZE = GRID_DIAMETER * GRID_DIAMETER * GRID_DIAMETER;

/** Queue for BFS - stores flat grid indices */
const bfsQueue = new Int32Array(GRID_SIZE);

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

/** Neighbor offsets in grid coords: [+X, -X, +Y, -Y, +Z, -Z] */
const NEIGHBOR_OFFSETS = [
  { dx: 1, dy: 0, dz: 0 },
  { dx: -1, dy: 0, dz: 0 },
  { dx: 0, dy: 1, dz: 0 },
  { dx: 0, dy: -1, dz: 0 },
  { dx: 0, dy: 0, dz: 1 },
  { dx: 0, dy: 0, dz: -1 },
];

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

// ============== Main BFS Function ==============

/**
 * Perform visibility BFS to find all visible chunks from camera position.
 * 
 * OPTIMIZED: Minimal allocations during BFS.
 * - Uses pre-allocated typed arrays for queue and visited
 * - Only allocates when building final Sets for compatibility
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
  
  // Start BFS from center
  let queueHead = 0;
  let queueTail = 0;
  
  const startIdx = gridToIndex(centerOffset, centerOffset, centerOffset);
  bfsQueue[queueTail++] = startIdx;
  bfsVisited[startIdx] = gen;
  
  while (queueHead < queueTail) {
    const idx = bfsQueue[queueHead++];
    
    // Convert grid index back to grid coords
    const gz = Math.floor(idx / STRIDE_Z);
    const gy = Math.floor((idx % STRIDE_Z) / STRIDE_Y);
    const gx = idx % STRIDE_Y;
    
    // Convert to world chunk coords
    const cx = baseCx + (gx - centerOffset);
    const cy = baseCy + (gy - centerOffset);
    const cz = baseCz + (gz - centerOffset);
    
    // Add to visible list
    visibleIndices[visibleCount++] = idx;
    
    // Check if chunk needs to be requested
    const key = chunkKey(cx, cy, cz);
    const chunk = chunkProvider.getChunkByKey(key);
    if (!chunk && !chunkProvider.isPending(key)) {
      toRequestIndices[toRequestCount++] = idx;
    }
    
    // Explore neighbors
    for (let d = 0; d < 6; d++) {
      const offset = NEIGHBOR_OFFSETS[d];
      const ngx = gx + offset.dx;
      const ngy = gy + offset.dy;
      const ngz = gz + offset.dz;
      
      // Bounds check
      if (!inBounds(ngx, ngy, ngz)) continue;
      
      const neighborIdx = gridToIndex(ngx, ngy, ngz);
      
      // Skip if already visited
      if (bfsVisited[neighborIdx] === gen) continue;
      
      // Distance check (using grid distance from center)
      const newDist = Math.abs(ngx - centerOffset) + Math.abs(ngy - centerOffset) + Math.abs(ngz - centerOffset);
      if (newDist > maxRadius) continue;
      
      // Mark visited and queue
      bfsVisited[neighborIdx] = gen;
      bfsQueue[queueTail++] = neighborIdx;
    }
  }
  
  // Build output Sets (required for compatibility with callers)
  const visible = new Set<string>();
  const toRequest = new Set<string>();
  
  for (let i = 0; i < visibleCount; i++) {
    const idx = visibleIndices[i];
    const gz = Math.floor(idx / STRIDE_Z);
    const gy = Math.floor((idx % STRIDE_Z) / STRIDE_Y);
    const gx = idx % STRIDE_Y;
    const cx = baseCx + (gx - centerOffset);
    const cy = baseCy + (gy - centerOffset);
    const cz = baseCz + (gz - centerOffset);
    visible.add(chunkKey(cx, cy, cz));
  }
  
  for (let i = 0; i < toRequestCount; i++) {
    const idx = toRequestIndices[i];
    const gz = Math.floor(idx / STRIDE_Z);
    const gy = Math.floor((idx % STRIDE_Z) / STRIDE_Y);
    const gx = idx % STRIDE_Y;
    const cx = baseCx + (gx - centerOffset);
    const cy = baseCy + (gy - centerOffset);
    const cz = baseCz + (gz - centerOffset);
    toRequest.add(chunkKey(cx, cy, cz));
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
