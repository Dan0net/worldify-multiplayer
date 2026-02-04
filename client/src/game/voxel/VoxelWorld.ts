/**
 * VoxelWorld - Manages chunk loading/unloading around the player
 */

import * as THREE from 'three';
import {
  VISIBILITY_RADIUS,
  VISIBILITY_UNLOAD_BUFFER,
  CHUNK_WORLD_SIZE,
  worldToChunk,
  chunkKey,
  BuildOperation,
  getAffectedChunks,
  drawToChunk,
  VoxelChunkData,
  encodeVoxelChunkRequest,
  encodeSurfaceColumnRequest,
  SurfaceColumnResponse,
  computeVisibility,
} from '@worldify/shared';
import { Chunk } from './Chunk.js';
import { meshChunk } from './ChunkMesher.js';
import { ChunkMesh } from './ChunkMesh.js';
import { sendBinary } from '../../net/netClient.js';
import { storeBridge } from '../../state/bridge.js';
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

  /** Whether the world has been initialized */
  private initialized = false;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
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
    this.updateWithVisibility(playerChunk);

    // Process some remesh queue items per frame
    this.processRemeshQueue(4); // Limit to 4 remeshes per frame
  }

  /**
   * Update using visibility BFS.
   * BFS only runs when player moves to a new chunk (hysteresis).
   * Frustum culling runs every frame for mesh visibility.
   */
  private updateWithVisibility(playerChunk: { cx: number; cy: number; cz: number }): void {
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

    const frustum = getFrustumFromCamera(this.camera);
    const cameraDir = getCameraDirection(this.camera);

    if (chunkChanged) {
      // Recompute BFS from new chunk
      this.lastBFSChunk = { ...playerChunk };
      
      const { reachable, toRequest } = getVisibleChunks(
        playerChunk,
        cameraDir,
        frustum,
        this,
        VISIBILITY_RADIUS
      );

      // Update cached reachable set
      this.cachedReachable = reachable;

      // Request missing chunks that are in frustum
      this.requestVisibleChunks(toRequest);
    }

    // Always update mesh visibility with frustum culling (camera may have rotated)
    this.updateMeshVisibilityWithFrustum(this.cachedReachable, frustum);

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
   * Request visible chunks that aren't loaded yet.
   * Requests one chunk at a time for smooth loading.
   */
  private requestVisibleChunks(toRequest: Set<string>): void {
    // Limit concurrent requests
    const MAX_PENDING = 4;
    if (this.pendingChunks.size >= MAX_PENDING) return;
    
    for (const key of toRequest) {
      if (this.pendingChunks.size >= MAX_PENDING) break;
      if (this.pendingChunks.has(key)) continue;
      
      // Parse key back to coordinates
      const [cx, cy, cz] = key.split(',').map(Number);
      this.requestChunkFromServer(cx, cy, cz);
    }
  }

  /** Reusable Box3 for frustum intersection tests */
  private static readonly tempBox = new THREE.Box3();

  /**
   * Update mesh visibility based on reachable chunks + frustum culling.
   * Uses hysteresis: show if reachable OR (loaded AND within extended radius).
   * This prevents popping when player crosses chunk boundaries.
   */
  private updateMeshVisibilityWithFrustum(reachable: Set<string>, frustum: THREE.Frustum): void {
    if (!this.lastPlayerChunk) return;
    
    const box = VoxelWorld.tempBox;
    const { cx: pcx, cy: pcy, cz: pcz } = this.lastPlayerChunk;
    const visibilityRadius = VISIBILITY_RADIUS + VISIBILITY_UNLOAD_BUFFER;

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

      // Frustum cull
      const worldX = chunk.cx * CHUNK_WORLD_SIZE;
      const worldY = chunk.cy * CHUNK_WORLD_SIZE;
      const worldZ = chunk.cz * CHUNK_WORLD_SIZE;
      box.min.set(worldX, worldY, worldZ);
      box.max.set(worldX + CHUNK_WORLD_SIZE, worldY + CHUNK_WORLD_SIZE, worldZ + CHUNK_WORLD_SIZE);

      chunkMesh.setVisible(frustum.intersectsBox(box));
    }
  }

  /**
   * Unload chunks that are far outside the reachable set.
   * Uses hysteresis (+2 chunks) to prevent popping at boundaries.
   */
  private unloadDistantChunks(reachable: Set<string>): void {
    if (!this.lastPlayerChunk) return;
    
    const { cx: pcx, cy: pcy, cz: pcz } = this.lastPlayerChunk;
    const unloadRadius = VISIBILITY_RADIUS + VISIBILITY_UNLOAD_BUFFER;
    
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
    
    // console.log(`[VoxelWorld] Requested chunk (${cx}, ${cy}, ${cz}) from server`);
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
    
    // Compute visibility graph for this chunk
    chunk.visibilityBits = computeVisibility(voxelData);
    
    // Queue for remeshing
    this.remeshQueue.add(key);
    
    // Invalidate BFS cache when new chunks load (they may open visibility paths)
    if (isNewChunk) {
      this.lastBFSChunk = null;
    }
    
    return chunk;
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
  receiveSurfaceColumnData(
    columnData: SurfaceColumnResponse,
    onTileReceived?: (tx: number, tz: number, heights: Int16Array, materials: Uint8Array) => void
  ): void {
    const { tx, tz, heights, materials, chunks } = columnData;
    const columnKey = `${tx},${tz}`;
    
    console.log(`[VoxelWorld] Received surface column (${tx}, ${tz}) with ${chunks.length} chunks`);
    
    // Remove from pending columns
    this.pendingColumns.delete(columnKey);
    
    // Process tile data (pass to callback for map overlay)
    if (onTileReceived) {
      onTileReceived(tx, tz, heights, materials);
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

  /** Neighbor offsets for 6 face-adjacent chunks */
  private static readonly NEIGHBOR_OFFSETS = [
    [-1, 0, 0], [1, 0, 0],
    [0, -1, 0], [0, 1, 0],
    [0, 0, -1], [0, 0, 1],
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
   * Remesh a single chunk.
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
   * Check if any of the chunk's 6 face neighbors are still pending from server.
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
   * Process some items from the remesh queue.
   * @param maxCount Maximum number of chunks to remesh this call
   */
  private processRemeshQueue(maxCount: number): void {
    let count = 0;
    const deferred: string[] = [];
    
    for (const key of this.remeshQueue) {
      if (count >= maxCount) break;

      const chunk = this.chunks.get(key);
      if (chunk) {
        // Defer meshing if any face neighbors are still pending from server
        // This prevents stitching artifacts from missing neighbor data
        if (this.hasNeighborsPending(chunk.cx, chunk.cy, chunk.cz)) {
          deferred.push(key);
          continue;
        }
        
        this.remeshChunk(chunk);
        count++;
      }
      this.remeshQueue.delete(key);
    }
    
    // Re-add deferred chunks to be processed next frame
    for (const key of deferred) {
      this.remeshQueue.delete(key); // Remove from current iteration position
      this.remeshQueue.add(key);    // Add back to end of Set
    }
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
      const chunk = this.chunks.get(key);
      if (!chunk) {
        // Chunk not loaded, skip (server has authoritative state)
        continue;
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

    // console.log(`[VoxelWorld] Applied build to ${modifiedKeys.length}/${affectedKeys.length} loaded chunks`);
    return modifiedKeys;
  }

  /**
   * Dispose of all chunks and meshes.
   */
  dispose(): void {
    // Dispose all meshes
    for (const chunkMesh of this.meshes.values()) {
      chunkMesh.disposeMesh(this.scene);
    }
    this.meshes.clear();

    // Clear chunks
    this.chunks.clear();

    // Clear pending
    this.pendingChunks.clear();

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
    
    // Dispose everything
    this.dispose();
    
    // Re-initialize
    this.initialized = true;
    
    // If player position provided, trigger update to reload chunks
    if (playerPos) {
      this.update(playerPos);
    }
  }
}
