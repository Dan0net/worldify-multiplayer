/**
 * VoxelWorld - Manages chunk loading/unloading around the player
 */

import * as THREE from 'three';
import {
  VISIBILITY_RADIUS,
  VISIBILITY_UNLOAD_BUFFER,
  worldToChunk,
  chunkKey,
  TerrainGenerator,
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

  /** Loaded bounds for stats */
  private loadedBounds = {
    minCx: 0, maxCx: 0,
    minCy: 0, maxCy: 0,
    minCz: 0, maxCz: 0,
  };

  /** Last player chunk position (for detecting chunk changes) */
  private lastPlayerChunk: { cx: number; cy: number; cz: number } | null = null;

  /** Queue of chunks that need remeshing */
  private remeshQueue: Set<string> = new Set();

  /** Whether the world has been initialized */
  private initialized = false;

  /** Terrain generator for procedural chunk generation (fallback for offline mode) */
  private readonly terrainGenerator: TerrainGenerator;

  constructor(scene: THREE.Scene, seed: number = 12345) {
    this.scene = scene;
    this.terrainGenerator = new TerrainGenerator({ seed });
  }

  /**
   * Initialize the world.
   * If server chunks are enabled (via store), just marks as initialized (chunks come from server).
   * Otherwise, generates initial chunks locally around origin.
   */
  init(): void {
    if (this.initialized) return;

    // If using server chunks, don't generate locally - wait for server data
    if (storeBridge.useServerChunks) {
      // console.log('[VoxelWorld] Waiting for server chunks...');
      this.initialized = true;
      return;
    }

    // Local mode: Generate initial chunks centered at origin
    const halfRadius = Math.floor(VISIBILITY_RADIUS / 2);

    for (let cz = -halfRadius; cz < halfRadius; cz++) {
      for (let cy = -halfRadius; cy < halfRadius; cy++) {
        for (let cx = -halfRadius; cx < halfRadius; cx++) {
          const key = chunkKey(cx, cy, cz);
          if (!this.chunks.has(key)) {
            const chunk = this.generateChunk(cx, cy, cz);
            this.chunks.set(key, chunk);
            this.remeshQueue.add(key);
          }
        }
      }
    }

    // Mesh all chunks (after all are loaded for neighbor access)
    this.remeshAllDirty();

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

    if (storeBridge.useServerChunks) {
      // Server mode: use visibility-based loading
      this.updateWithVisibility(playerChunk);
    } else {
      // Local mode: simple distance-based loading (for offline/testing)
      this.updateLocalMode(playerChunk);
    }

    // Process some remesh queue items per frame
    this.processRemeshQueue(4); // Limit to 4 remeshes per frame
  }

  /**
   * Update using visibility BFS (server mode).
   * Handles initial bootstrap + ongoing visibility-based loading.
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

    // Get visible chunks via BFS
    const frustum = getFrustumFromCamera(this.camera);
    const cameraDir = getCameraDirection(this.camera);
    
    const { visible, toRequest } = getVisibleChunks(
      playerChunk,
      cameraDir,
      frustum,
      this,
      VISIBILITY_RADIUS
    );

    // Request missing visible chunks (one at a time for smooth loading)
    this.requestVisibleChunks(toRequest);

    // Update mesh visibility
    this.updateMeshVisibility(visible);

    // Unload chunks far outside visible set
    this.unloadDistantChunks(visible);
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

  /**
   * Update mesh visibility based on visible chunk set.
   */
  private updateMeshVisibility(visible: Set<string>): void {
    for (const [key, chunkMesh] of this.meshes) {
      const shouldBeVisible = visible.has(key);
      chunkMesh.setVisible(shouldBeVisible);
    }
  }

  /**
   * Unload chunks that are far outside the visible set.
   */
  private unloadDistantChunks(visible: Set<string>): void {
    if (!this.lastPlayerChunk) return;
    
    const { cx: pcx, cy: pcy, cz: pcz } = this.lastPlayerChunk;
    const unloadRadius = VISIBILITY_RADIUS + VISIBILITY_UNLOAD_BUFFER;
    
    const chunksToUnload: string[] = [];
    for (const [key, chunk] of this.chunks) {
      // Keep if visible
      if (visible.has(key)) continue;
      
      // Unload if outside unload radius
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
   * Update in local/offline mode (simple distance-based).
   */
  private updateLocalMode(playerChunk: { cx: number; cy: number; cz: number }): void {
    const { cx: pcx, cy: pcy, cz: pcz } = playerChunk;
    const radius = Math.floor(VISIBILITY_RADIUS / 2);
    
    // Generate chunks within radius
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const cx = pcx + dx;
          const cy = pcy + dy;
          const cz = pcz + dz;
          const key = chunkKey(cx, cy, cz);
          
          if (!this.chunks.has(key)) {
            const chunk = this.generateChunk(cx, cy, cz);
            this.chunks.set(key, chunk);
            this.remeshQueue.add(key);
          }
        }
      }
    }
    
    // Unload distant chunks
    const unloadRadius = radius + VISIBILITY_UNLOAD_BUFFER;
    const chunksToUnload: string[] = [];
    for (const [key, chunk] of this.chunks) {
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
   * Receive chunk data from the server.
   * Called by the network layer when chunk data arrives.
   */
  receiveChunkData(chunkData: VoxelChunkData): void {
    const { chunkX, chunkY, chunkZ, voxelData } = chunkData;
    const key = chunkKey(chunkX, chunkY, chunkZ);
    
    // Remove from pending
    this.pendingChunks.delete(key);
    
    // Check if still in range (might have moved away while waiting)
    // For now, always accept the data - unload logic will handle it
    
    // Create or update chunk
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = new Chunk(chunkX, chunkY, chunkZ);
      this.chunks.set(key, chunk);
    }
    
    // Copy voxel data
    chunk.data.set(voxelData);
    chunk.dirty = true;
    
    // Compute visibility graph for this chunk
    chunk.visibilityBits = computeVisibility(voxelData);
    
    // Queue for remeshing
    this.remeshQueue.add(key);
    
    // Also queue neighbors for seamless boundaries
    this.queueNeighborRemesh(chunkX, chunkY, chunkZ);
    
    // console.log(`[VoxelWorld] Received chunk (${chunkX}, ${chunkY}, ${chunkZ}) seq=${lastBuildSeq}, ${voxelData.length} voxels`);
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
      const key = chunkKey(tx, chunkY, tz);
      
      // Remove from pending chunks if it was there
      this.pendingChunks.delete(key);
      
      // Create or update chunk
      let chunk = this.chunks.get(key);
      if (!chunk) {
        chunk = new Chunk(tx, chunkY, tz);
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

  /**
   * Generate a new chunk with terrain data using procedural generation.
   */
  generateChunk(cx: number, cy: number, cz: number): Chunk {
    const chunk = new Chunk(cx, cy, cz);
    // Generate terrain using the terrain generator
    const generatedData = this.terrainGenerator.generateChunk(cx, cy, cz);
    chunk.data.set(generatedData);
    chunk.dirty = true;

    // Debug: count solid voxels (material > 0)
    let solidCount = 0;
    for (let i = 0; i < generatedData.length; i++) {
      // Material is bits 5-11 (see shared/src/voxel/constants.ts)
      const material = (generatedData[i] >> 5) & 0x7F;
      if (material > 0) solidCount++;
    }
    // eslint-disable-next-line no-console
    // console.log(`Chunk [${cx},${cy},${cz}] solid voxels: ${solidCount}`);

    return chunk;
  }

  /**
   * Queue neighbor chunks for remeshing (for seamless boundaries).
   * Public so build system can trigger neighbor remesh after commits.
   */
  queueNeighborRemesh(cx: number, cy: number, cz: number): void {
    const offsets = [-1, 1];
    for (const dx of offsets) {
      const key = chunkKey(cx + dx, cy, cz);
      if (this.chunks.has(key)) {
        this.remeshQueue.add(key);
      }
    }
    for (const dy of offsets) {
      const key = chunkKey(cx, cy + dy, cz);
      if (this.chunks.has(key)) {
        this.remeshQueue.add(key);
      }
    }
    for (const dz of offsets) {
      const key = chunkKey(cx, cy, cz + dz);
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
    return (
      this.pendingChunks.has(chunkKey(cx - 1, cy, cz)) ||
      this.pendingChunks.has(chunkKey(cx + 1, cy, cz)) ||
      this.pendingChunks.has(chunkKey(cx, cy - 1, cz)) ||
      this.pendingChunks.has(chunkKey(cx, cy + 1, cz)) ||
      this.pendingChunks.has(chunkKey(cx, cy, cz - 1)) ||
      this.pendingChunks.has(chunkKey(cx, cy, cz + 1))
    );
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
    bounds: { minCx: number; maxCx: number; minCy: number; maxCy: number; minCz: number; maxCz: number };
  } {
    return {
      chunksLoaded: this.chunks.size,
      meshesVisible: this.getMeshCount(),
      remeshQueueSize: this.remeshQueue.size,
      bounds: { ...this.loadedBounds },
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
