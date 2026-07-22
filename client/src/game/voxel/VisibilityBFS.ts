/**
 * Visibility-based BFS traversal for chunk loading and rendering.
 * 
 * Implements Minecraft-style "Advanced Cave Culling Algorithm":
 * - Start from camera chunk
 * - BFS through chunks, checking visibility graph at each step
 * - Only traverse to neighbors if visibility allows
 * - Monotonic-direction rule: a path never reverses on an axis, so chunks reachable only by doubling
 *   back around an occluder (unseeable from the camera) are culled
 * - Apply distance limits (frustum culling is available but currently disabled here)
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
  CHUNK_WORLD_SIZE,
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
  /**
   * True ONLY when this chunk position is genuine open sky — above the column's content top, so no
   * voxel data exists there and none ever will. The BFS traverses through such chunks as transparent
   * (you can see the terrain beyond them). Returns false for unloaded TERRAIN (data exists but hasn't
   * streamed) and for unknown columns (no tile yet) — those must load before they can be traversed,
   * so we never see through not-yet-loaded rock.
   */
  isEmptyAir(cx: number, cy: number, cz: number): boolean;
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

/**
 * Directions travelled to reach each queued item — a 6-bit mask of `1 << ChunkFace` exit directions
 * accumulated along the path from the camera. Used by the monotonic-direction rule (see BFS loop).
 * Written per queue slot before enqueue and read at dequeue, so it needs no generation reset.
 */
const bfsDirMask = new Uint8Array(GRID_SIZE);

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
 * @param playerWorldPos - Player world position for fractional chunk offset (optional)
 * @returns Set of visible chunk keys and chunks to request
 */
export function getVisibleChunks(
  cameraChunk: { cx: number; cy: number; cz: number },
  _cameraDir: THREE.Vector3,  // Reserved for future direction-based culling
  _frustum: THREE.Frustum,
  chunkProvider: ChunkProvider,
  maxRadius: number = VISIBILITY_RADIUS,
  playerWorldPos?: { x: number; y: number; z: number },
  cube: boolean = false,
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
  
  // Fractional offset: player position within chunk, centered so 0 = chunk center
  // Shifts the BFS distance measurement to the player's actual position
  let fracX = 0, fracY = 0, fracZ = 0;
  if (playerWorldPos) {
    fracX = playerWorldPos.x / CHUNK_WORLD_SIZE - baseCx - 0.5;
    fracY = playerWorldPos.y / CHUNK_WORLD_SIZE - baseCy - 0.5;
    fracZ = playerWorldPos.z / CHUNK_WORLD_SIZE - baseCz - 0.5;
  }
  
  // Track counts
  let visibleCount = 0;
  let toRequestCount = 0;
  
  // Start BFS from center (camera chunk has no entry face = -1, sees all)
  let queueHead = 0;
  let queueTail = 0;
  
  const startIdx = gridToIndex(centerOffset, centerOffset, centerOffset);
  bfsQueue[queueTail] = startIdx;
  bfsEntryFace[queueTail] = -1; // Camera chunk: no entry face
  bfsDirMask[queueTail] = 0;    // Camera chunk: no directions travelled yet (all 6 may be seeded)
  queueTail++;
  bfsVisited[startIdx] = gen;
  
  while (queueHead < queueTail) {
    const idx = bfsQueue[queueHead];
    const entryFace = bfsEntryFace[queueHead];
    const dirMask = bfsDirMask[queueHead];
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

    // Determine how to traverse this cell.
    let effectiveVisBits: number;
    if (chunk) {
      // Loaded: use its real visibility graph (-1 = not computed yet → treat as all visible).
      const visBits = chunk.visibilityBits;
      effectiveVisBits = visBits === -1 ? VISIBILITY_ALL : visBits;
    } else if (chunkProvider.isEmptyAir(cx, cy, cz)) {
      // Genuine open sky above the terrain — no chunk will ever load here. Traverse through it as
      // transparent so the BFS can reach the terrain beyond (e.g. when high above the surface).
      // Nothing to request.
      effectiveVisBits = VISIBILITY_ALL;
    } else {
      // Unloaded TERRAIN (data exists but hasn't streamed) or an unknown column. Request it, but do
      // NOT traverse through it — assuming it's transparent could reveal chunks behind not-yet-loaded
      // rock. It streams in, and the next BFS (re-run on frontier change) traverses it for real.
      if (!chunkProvider.isPending(key)) {
        toRequestIndices[toRequestCount++] = idx;
      }
      continue;
    }

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
      
      // Distance check (offset by player's fractional position within their chunk). `cube` uses a
      // Chebyshev (square/box) radius — a full cube of chunks around the centre — so every LOD level
      // always has a complete ring/shell to swap in/out (no missing-corner gaps on a level change);
      // the default is the L1 (diamond) radius used in play.
      const ax = Math.abs(ngx - centerOffset - fracX);
      const ay = Math.abs(ngy - centerOffset - fracY);
      const az = Math.abs(ngz - centerOffset - fracZ);
      const newDist = cube ? Math.max(ax, ay, az) : ax + ay + az;
      if (newDist > maxRadius) continue;

      // Monotonic-direction rule (Minecraft ACCA): never step in a direction whose OPPOSITE has
      // already been travelled on this path (exit faces pair as f^1: +X/-X, +Y/-Y, +Z/-Z). This is
      // what stops the visibility search from leaking AROUND an occluder — a chunk reachable only via
      // a path that doubles back on an axis is culled, because you couldn't have seen it in a
      // straight line from the camera. The camera chunk starts with an empty mask and seeds all 6
      // faces, so every axis-direction still expands outward; it just can't reverse. Camera-facing
      // independent (no cameraDir) and computed inline, so no extra cost or per-frame recompute.
      if (dirMask & (1 << (exitFace ^ 1))) continue;

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
      bfsDirMask[queueTail] = dirMask | (1 << exitFace);
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