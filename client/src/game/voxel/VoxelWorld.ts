/**
 * VoxelWorld - Manages chunk loading/unloading around the player
 */

import * as THREE from 'three';
import {
  SURFACE_COLUMN_RADIUS,
  PLAYER_CHUNK_RADIUS,
  STREAM_UNLOAD_MARGIN,
  CHUNK_SIZE,
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
} from '@worldify/shared';
import { Chunk } from './Chunk.js';
import { meshChunk } from './ChunkMesher.js';
import { ChunkMesh } from './ChunkMesh.js';
import { sendBinary } from '../../net/netClient.js';
import { storeBridge } from '../../state/bridge.js';
import { getMapTileCache } from '../../ui/MapOverlay.js';

/** Callback type for requesting chunk data from server */
export type ChunkRequestFn = (cx: number, cy: number, cz: number) => void;

/**
 * Generate coordinates in concentric squares outward from center.
 * Yields (dx, dz) offsets from center, starting at (0,0) then spiraling out.
 */
function* concentricOffsets(radius: number): Generator<[number, number]> {
  // Center first
  yield [0, 0];
  
  // Each ring from 1 to radius
  for (let r = 1; r <= radius; r++) {
    // Top edge: z = -r, x from -r to r
    for (let x = -r; x <= r; x++) yield [x, -r];
    // Right edge: x = r, z from -r+1 to r
    for (let z = -r + 1; z <= r; z++) yield [r, z];
    // Bottom edge: z = r, x from r-1 to -r
    for (let x = r - 1; x >= -r; x--) yield [x, r];
    // Left edge: x = -r, z from r-1 to -r+1
    for (let z = r - 1; z > -r; z--) yield [-r, z];
  }
}

/**
 * Parse chunk key back to coordinates.
 */
function parseChunkKey(key: string): { cx: number; cy: number; cz: number } {
  const [cx, cy, cz] = key.split(',').map(Number);
  return { cx, cy, cz };
}

/**
 * Compute squared distance from a chunk to a reference point.
 * Uses XZ distance (horizontal) since that's more important for view.
 */
function chunkDistanceSq(cx: number, cz: number, refCx: number, refCz: number): number {
  const dx = cx - refCx;
  const dz = cz - refCz;
  return dx * dx + dz * dz;
}

/**
 * Manages the voxel world - chunk loading, unloading, and streaming.
 */
export class VoxelWorld {
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

  /** Currently loaded chunk coordinate bounds */
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
    const halfRadius = Math.floor(PLAYER_CHUNK_RADIUS / 2);

    for (let cz = -halfRadius; cz < halfRadius; cz++) {
      for (let cy = -halfRadius; cy < halfRadius; cy++) {
        for (let cx = -halfRadius; cx < halfRadius; cx++) {
          this.loadChunk(cx, cy, cz);
        }
      }
    }

    // Update bounds
    this.loadedBounds = {
      minCx: -halfRadius, maxCx: halfRadius - 1,
      minCy: -halfRadius, maxCy: halfRadius - 1,
      minCz: -halfRadius, maxCz: halfRadius - 1,
    };

    // Mesh all chunks (after all are loaded for neighbor access)
    this.remeshAllDirty();

    this.initialized = true;
  }

  /**
   * Update the world based on player position.
   * Load/unload chunks as player moves.
   * @param playerPos Player world position
   */
  update(playerPos: THREE.Vector3): void {
    if (!this.initialized) return;

    // Get player's current chunk
    const playerChunk = worldToChunk(playerPos.x, playerPos.y, playerPos.z);

    // Check if player moved to a new chunk (or first update)
    const chunkChanged = this.lastPlayerChunk === null ||
      playerChunk.cx !== this.lastPlayerChunk.cx ||
      playerChunk.cy !== this.lastPlayerChunk.cy ||
      playerChunk.cz !== this.lastPlayerChunk.cz;
    
    if (chunkChanged) {
      this.lastPlayerChunk = { ...playerChunk };
      // Unload distant chunks only on chunk change
      this.unloadDistantChunks(playerChunk.cx, playerChunk.cy, playerChunk.cz);
    }

    // Request missing chunks every frame (one column at a time for smooth loading)
    if (storeBridge.useServerChunks) {
      this.requestMissingColumns(playerChunk.cx, playerChunk.cz, SURFACE_COLUMN_RADIUS);
      this.requestMissing3DChunks(playerChunk.cx, playerChunk.cy, playerChunk.cz);
    }

    // Process some remesh queue items per frame
    this.processRemeshQueue(4); // Limit to 4 remeshes per frame
  }

  /**
   * Unload chunks that are too far from the player.
   */
  private unloadDistantChunks(pcx: number, pcy: number, pcz: number): void {
    // Unload bounds: use larger of surface XZ, plus margin for hysteresis
    const unloadMarginXZ = SURFACE_COLUMN_RADIUS + STREAM_UNLOAD_MARGIN;
    const unloadMarginY = PLAYER_CHUNK_RADIUS + STREAM_UNLOAD_MARGIN;
    
    const unloadMinCx = pcx - unloadMarginXZ;
    const unloadMaxCx = pcx + unloadMarginXZ - 1;
    const unloadMinCy = pcy - unloadMarginY;
    const unloadMaxCy = pcy + unloadMarginY - 1;
    const unloadMinCz = pcz - unloadMarginXZ;
    const unloadMaxCz = pcz + unloadMarginXZ - 1;

    // Unload chunks outside unload bounds
    const chunksToUnload: string[] = [];
    for (const [key, chunk] of this.chunks) {
      const outOfXZ = chunk.cx < unloadMinCx || chunk.cx > unloadMaxCx ||
                      chunk.cz < unloadMinCz || chunk.cz > unloadMaxCz;
      const outOfY = chunk.cy < unloadMinCy || chunk.cy > unloadMaxCy;
      
      if (outOfXZ || outOfY) {
        chunksToUnload.push(key);
      }
    }
    for (const key of chunksToUnload) {
      this.unloadChunk(key);
    }

    // Update bounds for reference
    this.loadedBounds = {
      minCx: pcx - SURFACE_COLUMN_RADIUS, maxCx: pcx + SURFACE_COLUMN_RADIUS - 1,
      minCy: pcy - PLAYER_CHUNK_RADIUS, maxCy: pcy + PLAYER_CHUNK_RADIUS - 1,
      minCz: pcz - SURFACE_COLUMN_RADIUS, maxCz: pcz + SURFACE_COLUMN_RADIUS - 1,
    };
  }

  /**
   * Request missing surface columns from server.
   * Only requests XZ columns, server determines which Y chunks to send.
   * Requests concentrically outward from player for better perceived loading.
   * Only requests one column at a time to ensure uniform loading.
   */
  private requestMissingColumns(
    centerCx: number, centerCz: number,
    radius: number
  ): void {
    // Wait for any pending column to return before requesting more
    if (this.pendingColumns.size > 0) return;
    
    for (const [dx, dz] of concentricOffsets(radius)) {
      const cx = centerCx + dx;
      const cz = centerCz + dz;
      const columnKey = `${cx},${cz}`;
      
      // Skip if we already have any chunks in this column
      if (this.hasAnyChunkInColumn(cx, cz)) continue;
      
      // Request this surface column and return (one at a time)
      this.pendingColumns.add(columnKey);
      const request = encodeSurfaceColumnRequest({ tx: cx, tz: cz });
      sendBinary(request);
      console.log(`[VoxelWorld] Requested surface column (${cx}, ${cz})`);
      return;
    }
  }

  /**
   * Request missing 3D chunks around the player.
   * Only requests chunks below surface height to avoid waste.
   * Skips columns without tile data (wait for surface column first).
   */
  private requestMissing3DChunks(pcx: number, pcy: number, pcz: number): void {
    const tileCache = getMapTileCache();
    
    const minCx = pcx - PLAYER_CHUNK_RADIUS;
    const maxCx = pcx + PLAYER_CHUNK_RADIUS - 1;
    const minCy = pcy - PLAYER_CHUNK_RADIUS;
    const maxCy = pcy + PLAYER_CHUNK_RADIUS - 1;
    const minCz = pcz - PLAYER_CHUNK_RADIUS;
    const maxCz = pcz + PLAYER_CHUNK_RADIUS - 1;
    
    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const columnKey = `${cx},${cz}`;
        
        // Skip if surface column is pending - wait for it to return first
        if (this.pendingColumns.has(columnKey)) continue;
        
        // Get surface height for this column to avoid requesting above surface
        // If no tile data yet, skip this column entirely (wait for surface column)
        const yRange = tileCache.getYRange(cx, cz);
        if (!yRange) continue;
        
        const surfaceCy = Math.floor(yRange.maxY / CHUNK_SIZE);
        
        for (let cy = minCy; cy <= maxCy; cy++) {
          // Skip chunks above surface (already covered by surface columns)
          if (cy > surfaceCy) continue;
          
          const key = chunkKey(cx, cy, cz);
          
          // Skip if already loaded or pending
          if (this.chunks.has(key)) continue;
          if (this.pendingChunks.has(key)) continue;
          
          // Request individual chunk
          this.requestChunkFromServer(cx, cy, cz);
        }
      }
    }
  }

  /**
   * Check if we have any chunks loaded in a column.
   */
  private hasAnyChunkInColumn(cx: number, cz: number): boolean {
    for (const chunk of this.chunks.values()) {
      if (chunk.cx === cx && chunk.cz === cz) {
        return true;
      }
    }
    return false;
  }

  /**
   * Load a chunk at the given coordinates.
   * If server chunks are enabled (via store), sends a request instead of generating locally.
   */
  private loadChunk(cx: number, cy: number, cz: number): Chunk | null {
    const key = chunkKey(cx, cy, cz);
    
    // Check if already loaded
    const existing = this.chunks.get(key);
    if (existing) return existing;

    // Check if already pending from server
    if (this.pendingChunks.has(key)) {
      return null;
    }

    if (storeBridge.useServerChunks) {
      // Request from server
      this.requestChunkFromServer(cx, cy, cz);
      return null;
    } else {
      // Generate locally (offline/fallback mode)
      const chunk = this.generateChunk(cx, cy, cz);
      this.chunks.set(key, chunk);
      return chunk;
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
   * Prioritizes chunks closest to player for better perceived loading.
   * @param maxCount Maximum number of chunks to remesh this call
   */
  private processRemeshQueue(maxCount: number): void {
    if (this.remeshQueue.size === 0) return;
    
    // Get player chunk for distance sorting
    const playerChunk = this.lastPlayerChunk ?? { cx: 0, cy: 0, cz: 0 };
    
    // Sort queue by distance from player (closest first)
    const sorted = [...this.remeshQueue].sort((a, b) => {
      const chunkA = parseChunkKey(a);
      const chunkB = parseChunkKey(b);
      return chunkDistanceSq(chunkA.cx, chunkA.cz, playerChunk.cx, playerChunk.cz) -
             chunkDistanceSq(chunkB.cx, chunkB.cz, playerChunk.cx, playerChunk.cz);
    });
    
    let count = 0;
    const deferred: string[] = [];
    
    for (const key of sorted) {
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
    
    // Re-add deferred chunks (they'll be re-sorted next frame)
    for (const key of deferred) {
      this.remeshQueue.delete(key);
    }
    for (const key of deferred) {
      this.remeshQueue.add(key);
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
