/**
 * VoxelWorld - Manages chunk loading/unloading around the player
 */

import * as THREE from 'three';
import {
  VISIBILITY_RADIUS,
  VISIBILITY_UNLOAD_BUFFER,
  CHUNK_WORLD_SIZE,
  CHUNK_SIZE,
  worldToChunk,
  chunkKey,
  parseChunkKey,
  BuildOperation,
  getAffectedChunks,
  drawToChunk,
  VoxelChunkData,
  encodeVoxelChunkRequest,
  encodeSurfaceColumnRequest,
  encodeMapTileRequest,
  SurfaceColumnResponse,
  MapTileResponse,
  computeVisibility,
  getChunkRangeFromHeights,
  isVoxelSolid,
  voxelIndex,
  computeSunlightColumns,
  getSunlitAbove,
  propagateLight,
} from '@worldify/shared';
import { Chunk } from './Chunk.js';
import { meshChunk, expandChunkToGrid } from './ChunkMesher.js';
import { ChunkMesh } from './ChunkMesh.js';
import { MeshWorkerPool, type MeshResult } from './MeshWorkerPool.js';
import { sendBinary } from '../../net/netClient.js';
import { storeBridge } from '../../state/bridge.js';
import { perfStats } from '../debug/PerformanceStats.js';
import { getShadowRadius } from '../quality/QualityManager.js';
import {
  getVisibleChunks,
  getFrustumFromCamera,
  getCameraDirection,
  type ChunkProvider,
} from './VisibilityBFS.js';

/** Callback type for requesting chunk data from server */
export type ChunkRequestFn = (cx: number, cy: number, cz: number) => void;

/**
 * Manages the voxel world - chunk loading, unloading, and streaming.
 */
export class VoxelWorld implements ChunkProvider {
  /** All loaded chunks, keyed by "cx,cy,cz" */
  readonly chunks: Map<string, Chunk> = new Map();

  /** All chunk meshes, keyed by "cx,cy,cz" */
  readonly meshes: Map<string, ChunkMesh> = new Map();

  /** Chunks pending data from server, keyed by "cx,cy,cz" */
  private pendingChunks: Set<string> = new Set();

  /** Columns pending data from server, keyed by "tx,tz" */
  private pendingColumns: Set<string> = new Set();

  /** Tiles pending from server, keyed by "tx,tz" */
  private pendingTiles: Set<string> = new Set();

  /** Column info from received tiles: maxCy for the column. Keyed by "tx,tz" */
  private columnInfo: Map<string, { maxCy: number }> = new Map();

  /** Callback to notify external systems (e.g. map cache) when a tile arrives */
  onTileReceived: ((tx: number, tz: number, heights: Int16Array, materials: Uint8Array) => void) | null = null;

  /** Callback when a chunk's remesh result is applied (used by BuildPreview to clear committed preview) */
  onChunkRemeshed: ((chunkKey: string) => void) | null = null;

  /** Reference to the Three.js scene */
  readonly scene: THREE.Scene;

  /** Camera reference for frustum culling */
  private camera: THREE.Camera | null = null;

  /** Whether initial surface column has been requested */
  private initialColumnRequested = false;

  /** Last player chunk position (for detecting chunk changes) */
  private lastPlayerChunk: { cx: number; cy: number; cz: number } | null = null;

  /** Last chunk where BFS was computed (for hysteresis) */
  private lastBFSChunk: { cx: number; cy: number; cz: number } | null = null;

  /** Cached reachable set from last BFS (reused until player changes chunk) */
  private cachedReachable: Set<string> = new Set();

  /** Queue of chunks that need remeshing */
  private remeshQueue: Set<string> = new Set();

  /** Reusable array for priority-sorted remesh processing (avoids allocation) */
  private remeshSortBuffer: string[] = [];

  /** Whether the world has been initialized */
  private initialized = false;

  /** Dynamic visibility radius (defaults to shared constant, overridden by quality settings) */
  private _visibilityRadius: number = VISIBILITY_RADIUS;

  /** Worker pool for off-thread mesh generation */
  readonly meshPool: MeshWorkerPool;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.meshPool = new MeshWorkerPool(2);
  }

  /**
   * Initialize the world.
   * Marks as initialized - chunks come from server.
   */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;
  }

  /**
   * Set the camera for frustum culling.
   */
  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  /**
   * Set visibility radius dynamically (quality settings).
   * Invalidates BFS cache so chunks update next frame.
   */
  setVisibilityRadius(radius: number): void {
    if (radius === this._visibilityRadius) return;
    this._visibilityRadius = radius;
    // Invalidate BFS cache so it recomputes with new radius
    this.lastBFSChunk = null;
    console.log(`[VoxelWorld] Visibility radius set to ${radius}`);
  }

  get visibilityRadius(): number {
    return this._visibilityRadius;
  }

  /**
   * ChunkProvider interface - get a chunk by key.
   */
  getChunkByKey(key: string): Chunk | undefined {
    return this.chunks.get(key);
  }

  /**
   * ChunkProvider interface - check if a chunk is pending.
   */
  isPending(key: string): boolean {
    return this.pendingChunks.has(key);
  }

  /**
   * Update the world based on player position.
   * Uses visibility BFS for loading and rendering.
   * @param playerPos Player world position
   */
  update(playerPos: THREE.Vector3): void {
    if (!this.initialized) return;

    // Get player's current chunk
    const playerChunk = worldToChunk(playerPos.x, playerPos.y, playerPos.z);
    this.lastPlayerChunk = { ...playerChunk };

    // Use visibility-based loading
    this.updateWithVisibility(playerChunk, playerPos);

    // Process some remesh queue items per frame
    // Process remesh queue with time budget (target 60fps = 16.6ms frame budget)
    perfStats.begin('remesh');
    this.processRemeshQueue(playerPos);
    perfStats.end('remesh');

    // Report queue stats for debug overlay
    perfStats.setVoxelQueueStats(this.remeshQueue.size, this.pendingChunks.size);
  }

  /**
   * Update using visibility BFS.
   * BFS only runs when player moves to a new chunk (hysteresis).
   * Frustum culling runs every frame for mesh visibility.
   */
  private updateWithVisibility(playerChunk: { cx: number; cy: number; cz: number }, playerPos?: THREE.Vector3): void {
    // Bootstrap: request initial surface column if not yet done
    if (!this.initialColumnRequested) {
      this.requestInitialSurfaceColumn(playerChunk.cx, playerChunk.cz);
      return; // Wait for initial data before starting visibility BFS
    }

    // Need camera for frustum culling
    if (!this.camera) {
      console.warn('[VoxelWorld] No camera set, skipping visibility update');
      return;
    }

    // Check if player moved to a new chunk (hysteresis)
    const chunkChanged = !this.lastBFSChunk ||
      playerChunk.cx !== this.lastBFSChunk.cx ||
      playerChunk.cy !== this.lastBFSChunk.cy ||
      playerChunk.cz !== this.lastBFSChunk.cz;

    if (chunkChanged) {
      const frustum = getFrustumFromCamera(this.camera);
      const cameraDir = getCameraDirection(this.camera);
      // Recompute BFS from new chunk
      this.lastBFSChunk = { ...playerChunk };
      
      const { reachable, toRequest } = getVisibleChunks(
        playerChunk,
        cameraDir,
        frustum,
        this,
        this._visibilityRadius,
        playerPos
      );

      // Update cached reachable set
      this.cachedReachable = reachable;

      // Request missing chunks that are in frustum
      this.requestVisibleChunks(toRequest);
    }

    // Always update mesh visibility (camera may have rotated)
    this.updateMeshVisibility(this.cachedReachable);

    // Unload chunks far outside reachable set (with +2 hysteresis buffer)
    this.unloadDistantChunks(this.cachedReachable);
  }

  /**
   * Request initial surface column to bootstrap the world.
   */
  private requestInitialSurfaceColumn(tx: number, tz: number): void {
    const columnKey = `${tx},${tz}`;
    if (this.pendingColumns.has(columnKey)) return;
    
    this.pendingColumns.add(columnKey);
    this.initialColumnRequested = true;
    
    const request = encodeSurfaceColumnRequest({ tx, tz });
    sendBinary(request);
    console.log(`[VoxelWorld] Requested initial surface column (${tx}, ${tz})`);
  }

  /** Face neighbor offsets: [dx, dy, dz] for +X, -X, +Y, -Y, +Z, -Z */
  private static readonly FACE_OFFSETS = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ] as const;

  /**
   * Check if a chunk has any non-solid (air/empty) voxels on a specific boundary face.
   * If so, a surface crossing may exist near that boundary and the neighbor chunk
   * is needed for correct margin data during meshing.
   */
  private static hasSurfaceNearFace(data: Uint16Array, faceIndex: number): boolean {
    const CS = CHUNK_SIZE;
    // Check the 2-deep boundary slice on the given face for any non-solid voxels.
    // If the entire slice is solid, no surface crossing can occur at that boundary.
    switch (faceIndex) {
      case 0: // +X: x = CS-2 .. CS-1
        for (let z = 0; z < CS; z++)
          for (let y = 0; y < CS; y++)
            for (let x = CS - 2; x < CS; x++)
              if (!isVoxelSolid(data[voxelIndex(x, y, z)])) return true;
        return false;
      case 1: // -X: x = 0 .. 1
        for (let z = 0; z < CS; z++)
          for (let y = 0; y < CS; y++)
            for (let x = 0; x < 2; x++)
              if (!isVoxelSolid(data[voxelIndex(x, y, z)])) return true;
        return false;
      case 2: // +Y: y = CS-2 .. CS-1
        for (let z = 0; z < CS; z++)
          for (let y = CS - 2; y < CS; y++)
            for (let x = 0; x < CS; x++)
              if (!isVoxelSolid(data[voxelIndex(x, y, z)])) return true;
        return false;
      case 3: // -Y: y = 0 .. 1
        for (let z = 0; z < CS; z++)
          for (let y = 0; y < 2; y++)
            for (let x = 0; x < CS; x++)
              if (!isVoxelSolid(data[voxelIndex(x, y, z)])) return true;
        return false;
      case 4: // +Z: z = CS-2 .. CS-1
        for (let z = CS - 2; z < CS; z++)
          for (let y = 0; y < CS; y++)
            for (let x = 0; x < CS; x++)
              if (!isVoxelSolid(data[voxelIndex(x, y, z)])) return true;
        return false;
      case 5: // -Z: z = 0 .. 1
        for (let z = 0; z < 2; z++)
          for (let y = 0; y < CS; y++)
            for (let x = 0; x < CS; x++)
              if (!isVoxelSolid(data[voxelIndex(x, y, z)])) return true;
        return false;
      default:
        return false;
    }
  }

  /**
   * Find face-neighbor chunks needed for stitching that BFS may have missed.
   * For each loaded chunk, if it has surface data near a boundary face and the
   * neighbor on that face is not loaded/pending/already requested, add it.
   */
  private getMarginNeighborRequests(bfsRequested: Set<string>): Set<string> {
    const extra = new Set<string>();
    for (const [, chunk] of this.chunks) {
      for (let face = 0; face < 6; face++) {
        const [dx, dy, dz] = VoxelWorld.FACE_OFFSETS[face];
        const nx = chunk.cx + dx;
        const ny = chunk.cy + dy;
        const nz = chunk.cz + dz;
        const nKey = chunkKey(nx, ny, nz);
        
        // Skip if already loaded, pending, or queued by BFS
        if (this.chunks.has(nKey) || this.pendingChunks.has(nKey) || bfsRequested.has(nKey)) continue;
        
        // Only request if this chunk has surface near that face
        if (VoxelWorld.hasSurfaceNearFace(chunk.data, face)) {
          extra.add(nKey);
        }
      }
    }
    return extra;
  }

  /**
   * Request visible chunks using two-phase approach:
   * Phase 1: Request tiles for columns we don't know about yet
   * Phase 2: Request individual chunks for columns where we have tile data
   * Phase 3: Request margin neighbors needed for stitching that BFS missed
   * 
   * Chunks above the tile's maxCy + 1 are skipped (air, +1 for top-face margin).
   */
  private requestVisibleChunks(toRequest: Set<string>): void {
    // Limit concurrent requests
    const MAX_PENDING_TILES = 4;
    const MAX_PENDING_CHUNKS = 4;

    // Phase 0: Add margin neighbor requests for stitching
    const marginNeighbors = this.getMarginNeighborRequests(toRequest);
    for (const key of marginNeighbors) {
      toRequest.add(key);
    }

    // Phase 1: Identify columns that need tiles
    const columnsNeedingTiles = new Set<string>();
    for (const key of toRequest) {
      const [cx, , cz] = key.split(',').map(Number);
      const columnKey = `${cx},${cz}`;
      if (!this.columnInfo.has(columnKey) && !this.pendingTiles.has(columnKey) && !this.pendingColumns.has(columnKey)) {
        columnsNeedingTiles.add(columnKey);
      }
    }

    // Request tiles for unknown columns
    for (const columnKey of columnsNeedingTiles) {
      if (this.pendingTiles.size >= MAX_PENDING_TILES) break;
      const [tx, tz] = columnKey.split(',').map(Number);
      this.requestTileFromServer(tx, tz);
    }

    // Phase 2: Request chunks only for columns we have tile info for
    let chunkRequests = 0;
    for (const key of toRequest) {
      if (this.pendingChunks.size >= MAX_PENDING_CHUNKS) break;
      if (chunkRequests >= MAX_PENDING_CHUNKS) break;
      if (this.pendingChunks.has(key)) continue;
      
      const [cx, cy, cz] = key.split(',').map(Number);
      const columnKey = `${cx},${cz}`;
      const info = this.columnInfo.get(columnKey);
      
      // Don't request chunks for columns without tile data yet
      if (!info) continue;
      
      // Skip chunks above the surface (+1 for top-face margin stitching)
      if (cy > info.maxCy + 1) continue;
      
      this.requestChunkFromServer(cx, cy, cz);
      chunkRequests++;
    }
  }

  /**
   * Update mesh visibility based on reachable chunks and distance.
   * Uses hysteresis: show if reachable OR (loaded AND within extended radius).
   * This prevents popping when player crosses chunk boundaries.
   * 
   * Also applies shadow distance culling: chunks beyond the shadow radius
   * have castShadow disabled so they don't contribute to the shadow pass.
   * 
   * NOTE: We intentionally do NOT frustum-cull here. Three.js's built-in per-mesh
   * frustum culling tests each mesh against the active camera independently (main
   * camera for the scene pass, light camera for shadow maps). Manual culling against
   * the main camera would hide chunks that still need to cast shadows into view.
   */
  private updateMeshVisibility(reachable: Set<string>): void {
    if (!this.lastPlayerChunk) return;
    
    const { cx: pcx, cy: pcy, cz: pcz } = this.lastPlayerChunk;
    const visibilityRadius = this._visibilityRadius + VISIBILITY_UNLOAD_BUFFER;
    const shadowRadius = getShadowRadius();

    for (const [key, chunkMesh] of this.meshes) {
      const chunk = this.chunks.get(key);
      if (!chunk) {
        chunkMesh.setVisible(false);
        continue;
      }

      // Hysteresis: show if reachable OR within extended radius
      const inReachable = reachable.has(key);
      const dx = Math.abs(chunk.cx - pcx);
      const dy = Math.abs(chunk.cy - pcy);
      const dz = Math.abs(chunk.cz - pcz);
      const inExtendedRadius = dx <= visibilityRadius && dy <= visibilityRadius && dz <= visibilityRadius;

      if (!inReachable && !inExtendedRadius) {
        chunkMesh.setVisible(false);
        continue;
      }

      chunkMesh.setVisible(true);

      // Shadow distance culling: only chunks within shadow radius cast shadows
      const inShadowRadius = dx <= shadowRadius && dy <= shadowRadius && dz <= shadowRadius;
      chunkMesh.setShadowCasting(inShadowRadius);
    }
  }

  /**
   * Unload chunks that are far outside the reachable set.
   * Uses hysteresis (+2 chunks) to prevent popping at boundaries.
   */
  private unloadDistantChunks(reachable: Set<string>): void {
    if (!this.lastPlayerChunk) return;
    
    const { cx: pcx, cy: pcy, cz: pcz } = this.lastPlayerChunk;
    const unloadRadius = this._visibilityRadius + VISIBILITY_UNLOAD_BUFFER;
    
    const chunksToUnload: string[] = [];
    for (const [key, chunk] of this.chunks) {
      // Keep if reachable via BFS
      if (reachable.has(key)) continue;
      
      // Unload if outside unload radius (hysteresis buffer)
      const dx = Math.abs(chunk.cx - pcx);
      const dy = Math.abs(chunk.cy - pcy);
      const dz = Math.abs(chunk.cz - pcz);
      
      if (dx > unloadRadius || dy > unloadRadius || dz > unloadRadius) {
        chunksToUnload.push(key);
      }
    }
    
    for (const key of chunksToUnload) {
      this.unloadChunk(key);
    }
  }

  /**
   * Request a chunk from the server.
   */
  private requestChunkFromServer(cx: number, cy: number, cz: number): void {
    const key = chunkKey(cx, cy, cz);
    this.pendingChunks.add(key);
    
    const request = encodeVoxelChunkRequest({
      chunkX: cx,
      chunkY: cy,
      chunkZ: cz,
      forceRegen: storeBridge.forceRegenerateChunks,
    });
    sendBinary(request);
  }

  /**
   * Request a tile from the server.
   * Server generates all surface chunks under the hood but only returns tile data.
   */
  private requestTileFromServer(tx: number, tz: number): void {
    const columnKey = `${tx},${tz}`;
    if (this.pendingTiles.has(columnKey)) return;
    
    this.pendingTiles.add(columnKey);
    sendBinary(encodeMapTileRequest({ tx, tz }));
  }

  /**
   * Receive standalone tile data from the server.
   * Stores column info (maxCy) so BFS can request chunks for this column.
   */
  receiveTileData(tileData: MapTileResponse): void {
    const { tx, tz, heights, materials } = tileData;
    const columnKey = `${tx},${tz}`;
    
    // Remove from pending
    this.pendingTiles.delete(columnKey);
    
    // Compute and store column info from tile heights
    const { maxCy } = getChunkRangeFromHeights(heights);
    this.columnInfo.set(columnKey, { maxCy });
    
    // Notify external systems (map cache)
    if (this.onTileReceived) {
      this.onTileReceived(tx, tz, heights, materials);
    }
    
    // Invalidate BFS cache so chunk requests can proceed for this column
    this.lastBFSChunk = null;
  }

  /**
   * Internal helper to ingest chunk data (shared by receiveChunkData and receiveSurfaceColumnData).
   * @returns The chunk that was created/updated
   */
  private ingestChunkData(cx: number, cy: number, cz: number, voxelData: Uint16Array, lastBuildSeq: number = 0): Chunk {
    const key = chunkKey(cx, cy, cz);
    
    // Remove from pending
    this.pendingChunks.delete(key);
    
    // Create or update chunk
    let chunk = this.chunks.get(key);
    const isNewChunk = !chunk;
    if (!chunk) {
      chunk = new Chunk(cx, cy, cz);
      this.chunks.set(key, chunk);
    }
    
    // Copy voxel data
    chunk.data.set(voxelData);
    chunk.dirty = true;
    chunk.lastBuildSeq = lastBuildSeq;
    
    // Sunlight column propagation (before visibility + remesh)
    this.computeChunkSunlight(cx, cy, cz, chunk.data);
    
    // Compute visibility graph for this chunk
    chunk.visibilityBits = computeVisibility(chunk.data);
    
    // Queue for remeshing
    this.remeshQueue.add(key);
    
    // Invalidate BFS cache when new chunks load (they may open visibility paths)
    if (isNewChunk) {
      this.lastBFSChunk = null;
      
      // Relight the chunk below — it may now receive (or lose) sunlight from us
      const belowKey = chunkKey(cx, cy - 1, cz);
      const belowChunk = this.chunks.get(belowKey);
      if (belowChunk) {
        this.computeChunkSunlight(cx, cy - 1, cz, belowChunk.data);
        belowChunk.dirty = true;
        this.remeshQueue.add(belowKey);
      }
    }
    
    return chunk;
  }

  /**
   * Compute sunlight columns for a chunk in-place.
   * Looks up chunk-above data and maxCy from columnInfo to determine sky exposure.
   */
  private computeChunkSunlight(cx: number, cy: number, cz: number, data: Uint16Array): void {
    // Get maxCy for this column (cx,cz maps to tile tx,tz)
    const colInfo = this.columnInfo.get(`${cx},${cz}`);
    const maxCy = colInfo ? colInfo.maxCy : cy; // fallback: treat current as top
    
    // Check chunk above for sunlight state
    const aboveKey = chunkKey(cx, cy + 1, cz);
    const aboveChunk = this.chunks.get(aboveKey);
    const isSunlitAbove = getSunlitAbove(
      aboveChunk?.data,
      cy,
      maxCy,
    );
    
    computeSunlightColumns(data, isSunlitAbove);
    propagateLight(data);
  }

  /**
   * Receive chunk data from the server.
   * Called by the network layer when chunk data arrives.
   */
  receiveChunkData(chunkData: VoxelChunkData): void {
    const { chunkX, chunkY, chunkZ, voxelData } = chunkData;
    this.ingestChunkData(chunkX, chunkY, chunkZ, voxelData);
    
    // Queue neighbors for seamless boundaries
    this.queueNeighborRemesh(chunkX, chunkY, chunkZ);
  }

  /**
   * Receive surface column data from the server.
   * Called by the network layer when surface column data arrives.
   * Contains a tile + multiple chunks for the column.
   */
  receiveSurfaceColumnData(columnData: SurfaceColumnResponse): void {
    const { tx, tz, heights, materials, chunks } = columnData;
    const columnKey = `${tx},${tz}`;
    
    console.log(`[VoxelWorld] Received surface column (${tx}, ${tz}) with ${chunks.length} chunks`);
    
    // Remove from pending columns
    this.pendingColumns.delete(columnKey);
    
    // Store column info from tile heights
    const { maxCy } = getChunkRangeFromHeights(heights);
    this.columnInfo.set(columnKey, { maxCy });
    
    // Notify external systems (map cache)
    if (this.onTileReceived) {
      this.onTileReceived(tx, tz, heights, materials);
    }
    
    // Process each chunk in the column
    for (const chunkInfo of chunks) {
      const { chunkY, lastBuildSeq, voxelData } = chunkInfo;
      this.ingestChunkData(tx, chunkY, tz, voxelData, lastBuildSeq);
    }
    
    // Queue neighbor remesh for all chunks in the column
    for (const chunkInfo of chunks) {
      this.queueNeighborRemesh(tx, chunkInfo.chunkY, tz);
    }
  }

  /**
   * Unload a chunk by key.
   */
  private unloadChunk(key: string): void {
    // Dispose mesh
    const chunkMesh = this.meshes.get(key);
    if (chunkMesh) {
      chunkMesh.disposeMesh(this.scene);
      this.meshes.delete(key);
    }

    // Remove from remesh queue
    this.remeshQueue.delete(key);

    // Remove from pending if it was still pending
    this.pendingChunks.delete(key);

    // Remove chunk
    this.chunks.delete(key);
  }

  /** Neighbor offsets for all 26 adjacent chunks (6 face + 12 edge + 8 corner).
   *  Full 26-neighborhood is needed because margin voxels at chunk edges/corners
   *  sample diagonal neighbors via getVoxelWithMargin. Without remeshing diagonal
   *  neighbors, stale extrapolated data causes seam cracks at multi-chunk junctions. */
  private static readonly NEIGHBOR_OFFSETS = [
    // 6 face neighbors
    [-1, 0, 0], [1, 0, 0],
    [0, -1, 0], [0, 1, 0],
    [0, 0, -1], [0, 0, 1],
    // 12 edge neighbors
    [-1, -1, 0], [-1, 1, 0], [1, -1, 0], [1, 1, 0],
    [-1, 0, -1], [-1, 0, 1], [1, 0, -1], [1, 0, 1],
    [0, -1, -1], [0, -1, 1], [0, 1, -1], [0, 1, 1],
    // 8 corner neighbors
    [-1, -1, -1], [-1, -1, 1], [-1, 1, -1], [-1, 1, 1],
    [1, -1, -1], [1, -1, 1], [1, 1, -1], [1, 1, 1],
  ] as const;

  /**
   * Queue neighbor chunks for remeshing (for seamless boundaries).
   * Public so build system can trigger neighbor remesh after commits.
   */
  queueNeighborRemesh(cx: number, cy: number, cz: number): void {
    for (const [dx, dy, dz] of VoxelWorld.NEIGHBOR_OFFSETS) {
      const key = chunkKey(cx + dx, cy + dy, cz + dz);
      if (this.chunks.has(key)) {
        this.remeshQueue.add(key);
      }
    }
  }

  /**
   * Remesh a single chunk synchronously.
   * Used by remeshAllDirty() and applyBuildOperation() where immediate results are needed.
   */
  remeshChunk(chunk: Chunk): void {
    const key = chunk.key;

    // Get or create ChunkMesh
    let chunkMesh = this.meshes.get(key);
    if (!chunkMesh) {
      chunkMesh = new ChunkMesh(chunk);
      this.meshes.set(key, chunkMesh);
    }

    // Generate mesh with neighbor data (solid + transparent)
    const output = meshChunk(chunk, this.chunks);

    // Update meshes
    chunkMesh.updateMeshes(output, this.scene);

    // Clear dirty flag
    chunk.clearDirty();
  }

  /**
   * Remesh all dirty chunks.
   */
  remeshAllDirty(): void {
    for (const chunk of this.chunks.values()) {
      if (chunk.dirty) {
        this.remeshChunk(chunk);
      }
    }
    this.remeshQueue.clear();
  }

  /**
   * Check if any of the chunk's 26 neighbors are still pending from server.
   * If so, we should delay meshing to avoid stitching artifacts.
   */
  private hasNeighborsPending(cx: number, cy: number, cz: number): boolean {
    for (const [dx, dy, dz] of VoxelWorld.NEIGHBOR_OFFSETS) {
      if (this.pendingChunks.has(chunkKey(cx + dx, cy + dy, cz + dz))) {
        return true;
      }
    }
    return false;
  }

  /** 
   * Maximum number of chunks to dispatch to workers per frame.
   * Each dispatch costs ~0.5ms (expand grid), so 8 dispatches ≈ 4ms.
   */
  private static readonly MAX_DISPATCHES_PER_FRAME = 8;

  /**
   * Process remesh queue by dispatching to worker pool.
   * 
   * Main thread expands chunk data (~0.5ms each), transfers grid to worker.
   * Worker runs SurfaceNet + geometry expansion (~3-5ms each, off-thread).
   * Results applied asynchronously via applyMeshResult.
   * 
   * - Sorts queue by distance to player (nearest chunks first)
   * - Skips chunks already in-flight
   * - Defers chunks with pending neighbors to avoid stitch artifacts
   */
  private processRemeshQueue(playerPos: THREE.Vector3): void {
    const queueSize = this.remeshQueue.size;
    if (queueSize === 0) return;

    // === Priority sort: nearest chunks first ===
    const sorted = this.remeshSortBuffer;
    sorted.length = 0;
    for (const key of this.remeshQueue) {
      sorted.push(key);
    }
    
    const px = playerPos.x / CHUNK_WORLD_SIZE;
    const py = playerPos.y / CHUNK_WORLD_SIZE;
    const pz = playerPos.z / CHUNK_WORLD_SIZE;
    
    sorted.sort((a, b) => {
      const ca = this.chunks.get(a);
      const cb = this.chunks.get(b);
      if (!ca || !cb) return ca ? -1 : cb ? 1 : 0;
      const da = (ca.cx - px) ** 2 + (ca.cy - py) ** 2 + (ca.cz - pz) ** 2;
      const db = (cb.cx - px) ** 2 + (cb.cy - py) ** 2 + (cb.cz - pz) ** 2;
      return da - db;
    });

    // === Dispatch to workers ===
    let dispatched = 0;
    
    for (let i = 0; i < sorted.length; ++i) {
      if (dispatched >= VoxelWorld.MAX_DISPATCHES_PER_FRAME) break;

      const key = sorted[i];

      const chunk = this.chunks.get(key);
      if (!chunk) {
        this.remeshQueue.delete(key);
        continue;
      }

      // Skip if already being meshed by a worker
      if (this.meshPool.isInFlight(key)) continue;

      // Skip chunks owned by build preview (avoid competing with preview batch)
      if (this.meshPool.isPreviewChunk(key)) continue;
      
      // Defer if any face neighbors are still pending from server
      if (this.hasNeighborsPending(chunk.cx, chunk.cy, chunk.cz)) continue;
      
      // Expand grid on main thread (~0.5ms) and dispatch to worker
      const grid = this.meshPool.takeGrid();
      const skipHighBoundary = expandChunkToGrid(chunk, this.chunks, grid);
      
      this.meshPool.dispatch(key, grid, skipHighBoundary, (result) => {
        this.applyMeshResult(result);
      });

      this.remeshQueue.delete(key);
      dispatched++;
    }
  }

  /**
   * Apply meshing results from a worker to the scene.
   * Called asynchronously when a worker completes.
   */
  private applyMeshResult(result: MeshResult): void {
    const { chunkKey: key, solid, transparent, liquid } = result;
    
    const chunk = this.chunks.get(key);
    if (!chunk) return; // Chunk was unloaded while worker was busy

    let chunkMesh = this.meshes.get(key);
    if (!chunkMesh) {
      chunkMesh = new ChunkMesh(chunk);
      this.meshes.set(key, chunkMesh);
    }

    chunkMesh.updateMeshesFromData(solid, transparent, liquid, this.scene);
    chunk.clearDirty();

    // Notify listeners (e.g. BuildPreview clears committed preview meshes)
    this.onChunkRemeshed?.(key);
  }

  /**
   * Get a chunk by coordinates.
   * @returns The chunk, or undefined if not loaded
   */
  getChunk(cx: number, cy: number, cz: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cy, cz));
  }

  /**
   * Get a chunk by world position.
   * @returns The chunk, or undefined if not loaded
   */
  getChunkAtWorld(x: number, y: number, z: number): Chunk | undefined {
    const { cx, cy, cz } = worldToChunk(x, y, z);
    return this.getChunk(cx, cy, cz);
  }

  /**
   * Get the total number of loaded chunks.
   */
  getChunkCount(): number {
    return this.chunks.size;
  }

  /**
   * Get the number of chunks with visible meshes.
   */
  getMeshCount(): number {
    let count = 0;
    for (const chunkMesh of this.meshes.values()) {
      if (chunkMesh.hasGeometry()) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get stats about the world.
   */
  getStats(): {
    chunksLoaded: number;
    meshesVisible: number;
    remeshQueueSize: number;
  } {
    return {
      chunksLoaded: this.chunks.size,
      meshesVisible: this.getMeshCount(),
      remeshQueueSize: this.remeshQueue.size,
    };
  }

  /**
   * Force reload and remesh all chunks.
   */
  refresh(): void {
    // Queue all chunks for remesh
    for (const key of this.chunks.keys()) {
      this.remeshQueue.add(key);
    }
    this.remeshAllDirty();
  }

  /**
   * Apply a build operation to the world.
   * Used when receiving build commits from the server.
   * @param operation The build operation to apply
   * @returns Array of modified chunk keys
   */
  applyBuildOperation(operation: BuildOperation): string[] {
    const affectedKeys = getAffectedChunks(operation);
    const modifiedKeys: string[] = [];

    for (const key of affectedKeys) {
      let chunk = this.chunks.get(key);
      if (!chunk) {
        // Chunk not loaded — create an empty one so the build can proceed.
        // Server has the authoritative terrain; this just ensures client
        // doesn't silently drop builds that extend into unloaded space.
        const { cx, cy, cz } = parseChunkKey(key);
        chunk = new Chunk(cx, cy, cz);
        this.chunks.set(key, chunk);
        this.lastBFSChunk = null; // invalidate BFS cache for new chunk
      }

      const changed = drawToChunk(chunk, operation);
      if (changed) {
        modifiedKeys.push(key);
        chunk.dirty = true;
        this.remeshQueue.add(key);
        
        // Recompute visibility for modified chunk
        chunk.visibilityBits = computeVisibility(chunk.data);
        
        // Also queue neighbors for seamless boundary updates
        this.queueNeighborRemesh(chunk.cx, chunk.cy, chunk.cz);
      }
    }

    // Invalidate BFS cache so visibility recomputes with updated chunk data.
    // Carving can expose previously-hidden chunks that need to be loaded.
    if (modifiedKeys.length > 0) {
      this.lastBFSChunk = null;
    }

    return modifiedKeys;
  }

  /**
   * Dispose of all chunks and meshes.
   * @param keepWorkers If true, workers are kept alive (for clearAndReload)
   */
  dispose(keepWorkers: boolean = false): void {
    // Terminate workers unless told to keep them
    if (!keepWorkers) {
      this.meshPool.dispose();
    }

    // Dispose all meshes
    for (const chunkMesh of this.meshes.values()) {
      chunkMesh.disposeMesh(this.scene);
    }
    this.meshes.clear();

    // Clear chunks
    this.chunks.clear();

    // Clear pending
    this.pendingChunks.clear();
    this.pendingColumns.clear();
    this.pendingTiles.clear();

    // Clear column info
    this.columnInfo.clear();

    // Clear queue
    this.remeshQueue.clear();

    // Reset player chunk tracking so next update triggers chunk loading
    this.lastPlayerChunk = null;

    this.initialized = false;
  }

  /**
   * Clear all chunks and reload from server.
   * Used for dev/debug to force fresh chunk generation.
   */
  clearAndReload(playerPos?: THREE.Vector3): void {
    console.log('[VoxelWorld] Clearing all chunks and reloading...');
    
    // Dispose chunks but keep workers alive
    this.dispose(true);
    
    // Re-initialize
    this.initialized = true;
    
    // If player position provided, trigger update to reload chunks
    if (playerPos) {
      this.update(playerPos);
    }
  }
}
