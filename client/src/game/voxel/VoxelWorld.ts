/**
 * VoxelWorld - Manages chunk loading/unloading around the player
 */

import * as THREE from 'three';
import {
  VISIBILITY_RADIUS,
  VISIBILITY_UNLOAD_BUFFER,
  CHUNK_WORLD_SIZE,
  CHUNK_SIZE,
  FACE_OFFSETS_6,
  POSITIVE_FACE_OFFSETS_3,
  MESH_MARGIN,
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
  injectBorderLight,
} from '@worldify/shared';
import { Chunk } from './Chunk.js';
import { meshChunk, expandChunkToGrid } from './ChunkMesher.js';
import { ChunkMesh } from './ChunkMesh.js';
import { TerrainBatch } from './TerrainBatch.js';
import { MeshWorkerPool, type MeshResult } from './MeshWorkerPool.js';
import { sendBinary } from '../../net/netClient.js';
import { storeBridge } from '../../state/bridge.js';
import { perfStats } from '../debug/PerformanceStats.js';
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

  /** Listeners notified when a chunk's remesh result is applied */
  private remeshListeners: Set<(chunkKey: string) => void> = new Set();

  /** Listeners notified when a chunk is unloaded */
  private unloadListeners: Set<(chunkKey: string) => void> = new Set();

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

  /** Build operations deferred until all affected chunks are loaded */
  private deferredBuildOps: Array<{ operation: BuildOperation; affectedKeys: string[] }> = [];

  /** Reusable array for priority-sorted remesh processing (avoids allocation) */
  private remeshSortBuffer: string[] = [];

  /** Whether the world has been initialized */
  private initialized = false;

  /** Dynamic visibility radius (defaults to shared constant, overridden by quality settings) */
  private _visibilityRadius: number = VISIBILITY_RADIUS;

  /** Worker pool for off-thread mesh generation */
  readonly meshPool: MeshWorkerPool;

  /** Number of mesh worker threads */
  private static readonly MESH_WORKER_COUNT = 2;

  /** Merges chunk geometries into spatial groups for draw-call reduction */
  private terrainBatch: TerrainBatch;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.meshPool = new MeshWorkerPool(VoxelWorld.MESH_WORKER_COUNT);
    this.terrainBatch = new TerrainBatch(scene);
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
   * Register a listener called when a chunk remesh result is applied.
   */
  addRemeshListener(listener: (chunkKey: string) => void): void {
    this.remeshListeners.add(listener);
  }

  /**
   * Remove a previously registered remesh listener.
   */
  removeRemeshListener(listener: (chunkKey: string) => void): void {
    this.remeshListeners.delete(listener);
  }

  /**
   * Register a listener called when a chunk is unloaded.
   */
  addUnloadListener(listener: (chunkKey: string) => void): void {
    this.unloadListeners.add(listener);
  }

  /**
   * Remove a previously registered unload listener.
   */
  removeUnloadListener(listener: (chunkKey: string) => void): void {
    this.unloadListeners.delete(listener);
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

    // Rebuild merged terrain groups (only dirty groups are re-merged)
    if (this.lastPlayerChunk) {
      const { cx, cy, cz } = this.lastPlayerChunk;
      this.terrainBatch.rebuild(cx, cy, cz);
    }

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

  /**
   * Compute a 6-bit bitmask indicating which faces of a chunk have non-solid
   * (air/empty) voxels in their margin strip. Bit i set ⇒ face i needs neighbor
   * data for correct stitching. Called once when chunk data arrives.
   *
   * Face indices follow FACE_OFFSETS_6: 0=+X, 1=-X, 2=+Y, 3=-Y, 4=+Z, 5=-Z.
   */
  static computeFaceSurfaceMask(data: Uint16Array): number {
    const CS = CHUNK_SIZE;
    let mask = 0;
    for (let face = 0; face < 6; face++) {
      const axis = face >> 1;              // 0,1→0  2,3→1  4,5→2
      const isPositive = (face & 1) === 0;
      const lo = isPositive ? CS - MESH_MARGIN : 0;
      const hi = isPositive ? CS : MESH_MARGIN;

      let found = false;
      const coords = [0, 0, 0];
      for (let a = 0; a < CS && !found; a++) {
        for (let b = 0; b < CS && !found; b++) {
          for (let c = lo; c < hi; c++) {
            coords[axis] = c;
            coords[(axis + 1) % 3] = a;
            coords[(axis + 2) % 3] = b;
            if (!isVoxelSolid(data[voxelIndex(coords[0], coords[1], coords[2])])) {
              found = true;
              break;
            }
          }
        }
      }
      if (found) mask |= (1 << face);
    }
    return mask;
  }

  /**
   * Find face-neighbor chunks needed for stitching that BFS may have missed.
   * Uses the cached faceSurfaceMask bitmask on each chunk to avoid scanning
   * voxel data every frame.
   */
  private getMarginNeighborRequests(bfsRequested: Set<string>): Set<string> {
    const extra = new Set<string>();
    for (const [, chunk] of this.chunks) {
      // Skip fully-solid chunks (no surface on any face)
      if (chunk.faceSurfaceMask === 0) continue;

      for (let face = 0; face < 6; face++) {
        // Check cached bitmask before allocating the key string
        if (!(chunk.faceSurfaceMask & (1 << face))) continue;

        const [dx, dy, dz] = FACE_OFFSETS_6[face];
        const nx = chunk.cx + dx;
        const ny = chunk.cy + dy;
        const nz = chunk.cz + dz;
        const nKey = chunkKey(nx, ny, nz);
        
        // Skip if already loaded, pending, or queued by BFS
        if (this.chunks.has(nKey) || this.pendingChunks.has(nKey) || bfsRequested.has(nKey)) continue;
        
        extra.add(nKey);
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
      if (cy > info.maxCy) continue;
      
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

    for (const [key, chunkMesh] of this.meshes) {
      const chunk = this.chunks.get(key);
      if (!chunk) {
        this.terrainBatch.setVisible(key, false);
        continue;
      }

      // Hysteresis: show if reachable OR within extended radius
      const inReachable = reachable.has(key);
      const dx = Math.abs(chunk.cx - pcx);
      const dy = Math.abs(chunk.cy - pcy);
      const dz = Math.abs(chunk.cz - pcz);
      const inExtendedRadius = dx <= visibilityRadius && dy <= visibilityRadius && dz <= visibilityRadius;

      if (!inReachable && !inExtendedRadius) {
        this.terrainBatch.setVisible(key, false);
        continue;
      }

      // Hide from merged batch if preview is active (preview meshes are in scene directly)
      if (chunkMesh.isPreviewActive()) {
        this.terrainBatch.setVisible(key, false);
        continue;
      }

      this.terrainBatch.setVisible(key, true);
      // Shadow culling is handled per-group in TerrainBatch.rebuild()
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
   * Request any unloaded chunks in the given key list from the server.
   * Skips chunks that are already loaded or pending.
   * Used by applyBuildOperation and BuildPreview to fetch affected chunks
   * that the client hasn't streamed yet.
   */
  requestMissingChunks(keys: string[]): void {
    for (const key of keys) {
      if (this.chunks.has(key) || this.pendingChunks.has(key)) continue;
      const { cx, cy, cz } = parseChunkKey(key);
      this.requestChunkFromServer(cx, cy, cz);
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

    // Cache face-surface bitmask (avoids per-frame voxel scanning in getMarginNeighborRequests)
    chunk.faceSurfaceMask = VoxelWorld.computeFaceSurfaceMask(chunk.data);
    
    // Queue for remeshing
    this.remeshQueue.add(key);
    
    // Invalidate BFS cache when new chunks load (they may open visibility paths)
    if (isNewChunk) {
      this.lastBFSChunk = null;
    }

    // Relight and re-queue face-adjacent neighbors so their border light and
    // margin data are up to date. Runs for both new and updated chunks —
    // updated chunks may carry build modifications that change boundary voxels.
    const belowKey = chunkKey(cx, cy - 1, cz);
    const belowChunk = this.chunks.get(belowKey);
    if (belowChunk) {
      this.computeChunkSunlight(cx, cy - 1, cz, belowChunk.data);
      belowChunk.dirty = true;
      this.remeshQueue.add(belowKey);
    }

    const aboveKey = chunkKey(cx, cy + 1, cz);
    const aboveChunk = this.chunks.get(aboveKey);
    if (aboveChunk) {
      this.computeChunkSunlight(cx, cy + 1, cz, aboveChunk.data);
      aboveChunk.dirty = true;
      this.remeshQueue.add(aboveKey);
    }

    for (const [dx, dy, dz] of FACE_OFFSETS_6) {
      if (dy !== 0) continue; // vertical already handled above
      const nKey = chunkKey(cx + dx, cy + dy, cz + dz);
      const nChunk = this.chunks.get(nKey);
      if (!nChunk) continue;
      this.computeChunkSunlight(nChunk.cx, nChunk.cy, nChunk.cz, nChunk.data);
      nChunk.dirty = true;
      this.remeshQueue.add(nKey);
    }

    // Execute any build operations that were waiting for this chunk
    this.drainDeferredBuildOps();
    
    return chunk;
  }

  /**
   * Compute sunlight columns for a chunk in-place.
   * Checks chunk-above data to determine sky exposure.
   * Then injects border light from face-adjacent neighbors and runs BFS.
   */
  private computeChunkSunlight(cx: number, cy: number, cz: number, data: Uint16Array): void {
    // Check chunk above for sunlight state
    const aboveKey = chunkKey(cx, cy + 1, cz);
    const aboveChunk = this.chunks.get(aboveKey);
    const isSunlitAbove = getSunlitAbove(aboveChunk?.data);
    
    computeSunlightColumns(data, isSunlitAbove);

    // Inject light from face-adjacent neighbor boundaries before BFS
    const neighbors: (Uint16Array | null)[] = FACE_OFFSETS_6.map(
      ([dx, dy, dz]) => this.chunks.get(chunkKey(cx + dx, cy + dy, cz + dz))?.data ?? null,
    );
    injectBorderLight(data, neighbors);

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
    
    // Process chunks top-down so sunlight propagates correctly from sky to ground.
    // Server sends them bottom-up, so reverse the order.
    for (let i = chunks.length - 1; i >= 0; i--) {
      const { chunkY, lastBuildSeq, voxelData } = chunks[i];
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
    // Notify listeners before cleanup
    for (const listener of this.unloadListeners) listener(key);

    // Remove from terrain batch before disposing geometry
    this.terrainBatch.removeChunk(key);

    // Dispose mesh
    const chunkMesh = this.meshes.get(key);
    if (chunkMesh) {
      chunkMesh.disposeMeshes(this.scene);
      this.meshes.delete(key);
    }

    // Remove from remesh queue
    this.remeshQueue.delete(key);

    // Remove from pending if it was still pending
    this.pendingChunks.delete(key);

    // Remove chunk
    this.chunks.delete(key);
  }

  /**
   * Queue face-neighbor chunks for remeshing (for seamless boundaries).
   * Only the 6 face neighbors can share margin data with this chunk.
   * Public so build system can trigger neighbor remesh after commits.
   */
  queueNeighborRemesh(cx: number, cy: number, cz: number): void {
    for (const [dx, dy, dz] of FACE_OFFSETS_6) {
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

    // Update meshes (no scene — TerrainBatch owns scene meshes)
    chunkMesh.updateMeshes(output);

    // Register geometry with terrain batch for merged rendering
    const worldPos = chunk.getWorldPosition();
    this.terrainBatch.updateChunk(key, chunk.cx, chunk.cy, chunk.cz, [
      chunkMesh.solidMesh?.geometry ?? null,
      chunkMesh.transparentMesh?.geometry ?? null,
      chunkMesh.liquidMesh?.geometry ?? null,
    ], worldPos);

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
   * Check if any positive-face neighbor (+X, +Y, +Z) is still pending.
   * Only these 3 supply margin data for this chunk's mesh.
   */
  private hasNeighborsPending(cx: number, cy: number, cz: number): boolean {
    for (const [dx, dy, dz] of POSITIVE_FACE_OFFSETS_3) {
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

    // No scene param — TerrainBatch owns scene meshes
    chunkMesh.updateMeshesFromData(solid, transparent, liquid);
    chunk.clearDirty();

    // Register geometry with terrain batch for merged rendering
    const worldPos = chunk.getWorldPosition();
    this.terrainBatch.updateChunk(key, chunk.cx, chunk.cy, chunk.cz, [
      chunkMesh.solidMesh?.geometry ?? null,
      chunkMesh.transparentMesh?.geometry ?? null,
      chunkMesh.liquidMesh?.geometry ?? null,
    ], worldPos);

    // Notify listeners (e.g. collision rebuild, BuildPreview committed preview cleanup)
    for (const listener of this.remeshListeners) listener(key);
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
   *
   * If any affected chunk isn't loaded yet, the ENTIRE operation is deferred
   * until all chunks arrive (prevents holes at chunk boundaries).
   *
   * @param operation The build operation to apply
   * @returns Array of modified chunk keys (empty if deferred)
   */
  applyBuildOperation(operation: BuildOperation): string[] {
    const affectedKeys = getAffectedChunks(operation);

    // Check if any affected chunk is missing
    const hasMissing = affectedKeys.some(key => !this.chunks.has(key));
    if (hasMissing) {
      // Request missing chunks and defer the entire operation
      this.requestMissingChunks(affectedKeys);
      this.deferredBuildOps.push({ operation, affectedKeys });
      return [];
    }

    return this.executeBuildOperation(operation, affectedKeys);
  }

  /**
   * Execute a build operation (all affected chunks must be loaded).
   * All touched chunks are dispatched as an atomic batch so their meshes
   * update in the same frame — prevents boundary flashes.
   */
  private executeBuildOperation(operation: BuildOperation, affectedKeys: string[]): string[] {
    const modifiedKeys: string[] = [];
    const batchKeys = new Set<string>();

    for (const key of affectedKeys) {
      const chunk = this.chunks.get(key)!;

      const changed = drawToChunk(chunk, operation);
      if (changed) {
        modifiedKeys.push(key);
        chunk.dirty = true;
        batchKeys.add(key);
        
        // Recompute visibility for modified chunk
        chunk.visibilityBits = computeVisibility(chunk.data);
        
        // Relight this chunk (column pass overwrites all light, border inject + BFS re-spreads)
        this.computeChunkSunlight(chunk.cx, chunk.cy, chunk.cz, chunk.data);

        // Cascade relighting downward — sunlight may now pass (or be blocked)
        let belowCy = chunk.cy - 1;
        while (true) {
          const belowKey = chunkKey(chunk.cx, belowCy, chunk.cz);
          const belowChunk = this.chunks.get(belowKey);
          if (!belowChunk) break;
          this.computeChunkSunlight(chunk.cx, belowCy, chunk.cz, belowChunk.data);
          belowChunk.dirty = true;
          batchKeys.add(belowKey);
          belowCy--;
        }

        // Cascade relighting upward — removing a floor lets light enter from below
        const aboveKey = chunkKey(chunk.cx, chunk.cy + 1, chunk.cz);
        const aboveChunk = this.chunks.get(aboveKey);
        if (aboveChunk) {
          this.computeChunkSunlight(chunk.cx, chunk.cy + 1, chunk.cz, aboveChunk.data);
          aboveChunk.dirty = true;
          batchKeys.add(aboveKey);
        }

        // Relight face-adjacent horizontal neighbors so their border light updates.
        for (const [dx, dy, dz] of FACE_OFFSETS_6) {
          if (dy !== 0) continue; // vertical already handled above
          const nKey = chunkKey(chunk.cx + dx, chunk.cy + dy, chunk.cz + dz);
          const nChunk = this.chunks.get(nKey);
          if (!nChunk) continue;
          this.computeChunkSunlight(nChunk.cx, nChunk.cy, nChunk.cz, nChunk.data);
          nChunk.dirty = true;
          batchKeys.add(nKey);
        }
      }
    }

    // Invalidate BFS cache so visibility recomputes with updated chunk data.
    // Carving can expose previously-hidden chunks that need to be loaded.
    if (modifiedKeys.length > 0) {
      this.lastBFSChunk = null;
    }

    // Dispatch all affected chunks as one atomic batch so every mesh
    // updates in the same frame — no boundary flash between neighbors.
    this.dispatchBuildBatch(batchKeys);

    return modifiedKeys;
  }

  /**
   * Expand grids and dispatch a set of chunks as an atomic batch.
   * All mesh results are applied together in one frame.
   */
  private dispatchBuildBatch(keys: Set<string>): void {
    const batchItems: Array<{
      chunkKey: string;
      grid: Uint16Array;
      skipHighBoundary: [boolean, boolean, boolean];
    }> = [];

    for (const key of keys) {
      const chunk = this.chunks.get(key);
      if (!chunk) continue;

      // Remove from remeshQueue — the batch handles it
      this.remeshQueue.delete(key);

      const grid = this.meshPool.takeGrid();
      const skipHighBoundary = expandChunkToGrid(chunk, this.chunks, grid);
      batchItems.push({ chunkKey: key, grid, skipHighBoundary });
    }

    if (batchItems.length === 0) return;

    this.meshPool.dispatchBatch(batchItems, (results) => {
      for (const result of results) {
        this.applyMeshResult(result);
      }
    });
  }

  /**
   * Try to execute deferred build operations whose chunks have all arrived.
   * Called from ingestChunkData whenever a new chunk becomes available.
   */
  private drainDeferredBuildOps(): void {
    if (this.deferredBuildOps.length === 0) return;

    // Iterate in reverse so splice doesn't shift unprocessed indices
    for (let i = this.deferredBuildOps.length - 1; i >= 0; i--) {
      const { operation, affectedKeys } = this.deferredBuildOps[i];
      if (affectedKeys.every(key => this.chunks.has(key))) {
        this.deferredBuildOps.splice(i, 1);
        this.executeBuildOperation(operation, affectedKeys);
      }
    }
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

    // Dispose terrain batch (removes merged meshes from scene)
    this.terrainBatch.dispose();

    // Dispose all chunk mesh holders
    for (const chunkMesh of this.meshes.values()) {
      chunkMesh.disposeMeshes(this.scene);
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

    // Clear deferred build operations
    this.deferredBuildOps.length = 0;

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
