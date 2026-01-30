/**
 * VoxelWorld - Manages chunk loading/unloading around the player
 */

import * as THREE from 'three';
import {
  STREAM_RADIUS,
  worldToChunk,
  chunkKey,
  TerrainGenerator,
  Chunk,
} from '@worldify/shared';
import { meshChunk } from './SurfaceNet.js';
import { ChunkMesh } from './ChunkMesh.js';

/**
 * Manages the voxel world - chunk loading, unloading, and streaming.
 */
export class VoxelWorld {
  /** All loaded chunks, keyed by "cx,cy,cz" */
  readonly chunks: Map<string, Chunk> = new Map();

  /** All chunk meshes, keyed by "cx,cy,cz" */
  readonly meshes: Map<string, ChunkMesh> = new Map();

  /** Reference to the Three.js scene */
  readonly scene: THREE.Scene;

  /** Currently loaded chunk coordinate bounds */
  private loadedBounds = {
    minCx: 0, maxCx: 0,
    minCy: 0, maxCy: 0,
    minCz: 0, maxCz: 0,
  };

  /** Last player chunk position (for detecting chunk changes) */
  private lastPlayerChunk = { cx: 0, cy: 0, cz: 0 };

  /** Queue of chunks that need remeshing */
  private remeshQueue: Set<string> = new Set();

  /** Whether the world has been initialized */
  private initialized = false;

  /** Terrain generator for procedural chunk generation */
  private readonly terrainGenerator: TerrainGenerator;

  constructor(scene: THREE.Scene, seed: number = 12345) {
    this.scene = scene;
    this.terrainGenerator = new TerrainGenerator({ seed });
  }

  /**
   * Initialize the world - generate initial chunks around origin.
   */
  init(): void {
    if (this.initialized) return;

    // Generate initial 4×4×4 chunks centered at origin
    // Stream radius of 2 means chunks from -2 to +1 (4 chunks per axis)
    const halfRadius = Math.floor(STREAM_RADIUS / 2);

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

    // Check if player moved to a new chunk
    if (
      playerChunk.cx !== this.lastPlayerChunk.cx ||
      playerChunk.cy !== this.lastPlayerChunk.cy ||
      playerChunk.cz !== this.lastPlayerChunk.cz
    ) {
      this.lastPlayerChunk = { ...playerChunk };
      this.updateLoadedChunks(playerChunk.cx, playerChunk.cy, playerChunk.cz);
    }

    // Process some remesh queue items per frame
    this.processRemeshQueue(4); // Limit to 4 remeshes per frame
  }

  /**
   * Update which chunks are loaded based on new player position.
   */
  private updateLoadedChunks(pcx: number, pcy: number, pcz: number): void {
    const halfRadius = Math.floor(STREAM_RADIUS / 2);
    
    const newMinCx = pcx - halfRadius;
    const newMaxCx = pcx + halfRadius - 1;
    const newMinCy = pcy - halfRadius;
    const newMaxCy = pcy + halfRadius - 1;
    const newMinCz = pcz - halfRadius;
    const newMaxCz = pcz + halfRadius - 1;

    // Unload chunks that are now out of range
    const chunksToUnload: string[] = [];
    for (const [key, chunk] of this.chunks) {
      if (
        chunk.cx < newMinCx || chunk.cx > newMaxCx ||
        chunk.cy < newMinCy || chunk.cy > newMaxCy ||
        chunk.cz < newMinCz || chunk.cz > newMaxCz
      ) {
        chunksToUnload.push(key);
      }
    }
    for (const key of chunksToUnload) {
      this.unloadChunk(key);
    }

    // Load new chunks that are now in range
    for (let cz = newMinCz; cz <= newMaxCz; cz++) {
      for (let cy = newMinCy; cy <= newMaxCy; cy++) {
        for (let cx = newMinCx; cx <= newMaxCx; cx++) {
          const key = chunkKey(cx, cy, cz);
          if (!this.chunks.has(key)) {
            this.loadChunk(cx, cy, cz);
            this.remeshQueue.add(key);
            
            // Also queue neighbors for remesh (for seamless boundaries)
            this.queueNeighborRemesh(cx, cy, cz);
          }
        }
      }
    }

    this.loadedBounds = {
      minCx: newMinCx, maxCx: newMaxCx,
      minCy: newMinCy, maxCy: newMaxCy,
      minCz: newMinCz, maxCz: newMaxCz,
    };
  }

  /**
   * Load a chunk at the given coordinates.
   */
  private loadChunk(cx: number, cy: number, cz: number): Chunk {
    const key = chunkKey(cx, cy, cz);
    
    // Check if already loaded
    const existing = this.chunks.get(key);
    if (existing) return existing;

    // Generate new chunk
    const chunk = this.generateChunk(cx, cy, cz);
    this.chunks.set(key, chunk);

    return chunk;
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
    console.log(`Chunk [${cx},${cy},${cz}] solid voxels: ${solidCount}`);

    return chunk;
  }

  /**
   * Queue neighbor chunks for remeshing (for seamless boundaries).
   */
  private queueNeighborRemesh(cx: number, cy: number, cz: number): void {
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

    // Generate mesh with neighbor data
    const output = meshChunk(chunk, this.chunks);

    // Update mesh
    chunkMesh.updateMesh(output, this.scene);

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
   * Process some items from the remesh queue.
   * @param maxCount Maximum number of chunks to remesh this call
   */
  private processRemeshQueue(maxCount: number): void {
    let count = 0;
    for (const key of this.remeshQueue) {
      if (count >= maxCount) break;

      const chunk = this.chunks.get(key);
      if (chunk) {
        this.remeshChunk(chunk);
        count++;
      }
      this.remeshQueue.delete(key);
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

    // Clear queue
    this.remeshQueue.clear();

    this.initialized = false;
  }
}
