/**
 * RemeshPipeline - Manages the chunk remesh queue and worker dispatch
 *
 * Responsibilities:
 * - Maintains a priority-sorted remesh queue
 * - Dispatches chunks to MeshWorkerPool (async) or meshes synchronously
 * - Applies worker results to ChunkGeometry + ChunkGrouper
 * - Provides batch dispatch for atomic build operations
 *
 * Decoupled from VoxelWorld via callbacks for chunk/geometry lookup.
 */

import * as THREE from 'three';
import {
  CHUNK_WORLD_SIZE,
  POSITIVE_FACE_OFFSETS_3,
  chunkKey,
} from '@worldify/shared';
import { Chunk } from './Chunk.js';
import { ChunkGeometry } from './ChunkGeometry.js';
import { ChunkGrouper } from './ChunkGrouper.js';
import { meshChunk, expandChunkToGrid } from './ChunkMesher.js';
import { MeshWorkerPool, type MeshResult } from './MeshWorkerPool.js';

// ---- Types ----

/** Callback fired when a chunk remesh result is applied */
export type RemeshListener = (chunkKey: string) => void;

// ============================================================
// RemeshPipeline
// ============================================================

export class RemeshPipeline {
  /** Chunks that need remeshing */
  readonly queue = new Set<string>();

  /** Listeners notified when a remesh result is applied */
  private listeners = new Set<RemeshListener>();

  /** Reusable array for priority-sorted processing (avoids allocation) */
  private sortBuffer: string[] = [];

  /** Maximum dispatches per frame (~0.5ms each → 8 = ~4ms) */
  private static readonly MAX_DISPATCHES = 8;

  // ---- Dependencies (injected) ----
  private readonly chunks: Map<string, Chunk>;
  private readonly geometries: Map<string, ChunkGeometry>;
  private readonly grouper: ChunkGrouper;
  private readonly meshPool: MeshWorkerPool;
  private readonly pendingChunks: Set<string>;

  constructor(
    chunks: Map<string, Chunk>,
    geometries: Map<string, ChunkGeometry>,
    grouper: ChunkGrouper,
    meshPool: MeshWorkerPool,
    pendingChunks: Set<string>,
  ) {
    this.chunks = chunks;
    this.geometries = geometries;
    this.grouper = grouper;
    this.meshPool = meshPool;
    this.pendingChunks = pendingChunks;
  }

  // ---- Listeners ----

  addListener(fn: RemeshListener): void { this.listeners.add(fn); }
  removeListener(fn: RemeshListener): void { this.listeners.delete(fn); }

  // ---- Queue management ----

  add(key: string): void { this.queue.add(key); }
  delete(key: string): void { this.queue.delete(key); }
  clear(): void { this.queue.clear(); }
  get size(): number { return this.queue.size; }

  // ---- Processing ----

  /**
   * Process the remesh queue by dispatching to workers.
   * Sorts by distance (nearest first), with priority keys at front.
   * Skips chunks already in-flight or with pending neighbors.
   */
  process(playerPos: THREE.Vector3, priorityKeys?: Set<string>): void {
    if (this.queue.size === 0) return;

    const sorted = this.sortBuffer;
    sorted.length = 0;
    for (const key of this.queue) sorted.push(key);

    const px = playerPos.x / CHUNK_WORLD_SIZE;
    const py = playerPos.y / CHUNK_WORLD_SIZE;
    const pz = playerPos.z / CHUNK_WORLD_SIZE;

    sorted.sort((a, b) => {
      // Priority chunks first
      if (priorityKeys) {
        const ap = priorityKeys.has(a) ? 0 : 1;
        const bp = priorityKeys.has(b) ? 0 : 1;
        if (ap !== bp) return ap - bp;
      }
      const ca = this.chunks.get(a);
      const cb = this.chunks.get(b);
      if (!ca || !cb) return ca ? -1 : cb ? 1 : 0;
      const da = (ca.cx - px) ** 2 + (ca.cy - py) ** 2 + (ca.cz - pz) ** 2;
      const db = (cb.cx - px) ** 2 + (cb.cy - py) ** 2 + (cb.cz - pz) ** 2;
      return da - db;
    });

    let dispatched = 0;
    for (let i = 0; i < sorted.length; ++i) {
      if (dispatched >= RemeshPipeline.MAX_DISPATCHES) break;

      const key = sorted[i];
      const chunk = this.chunks.get(key);
      if (!chunk) { this.queue.delete(key); continue; }

      if (this.meshPool.isInFlight(key)) continue;
      if (this.meshPool.isPreviewChunk(key)) continue;
      if (this.hasNeighborsPending(chunk.cx, chunk.cy, chunk.cz)) continue;

      const grid = this.meshPool.takeGrid();
      const skipHighBoundary = expandChunkToGrid(chunk, this.chunks, grid);

      this.meshPool.dispatch(key, grid, skipHighBoundary, (result) => {
        this.applyResult(result);
      });

      this.queue.delete(key);
      dispatched++;
    }
  }

  /**
   * Remesh a single chunk synchronously (fallback / immediate path).
   */
  remeshSync(chunk: Chunk): void {
    const key = chunk.key;

    let geo = this.geometries.get(key);
    if (!geo) {
      geo = new ChunkGeometry(chunk);
      this.geometries.set(key, geo);
    }

    const output = meshChunk(chunk, this.chunks);
    geo.updateFromSurfaceNet(output);
    this.registerWithGrouper(key, chunk, geo);
    chunk.clearDirty();
  }

  /**
   * Remesh all dirty chunks synchronously.
   */
  remeshAllDirty(): void {
    for (const chunk of this.chunks.values()) {
      if (chunk.dirty) this.remeshSync(chunk);
    }
    this.queue.clear();
  }

  /**
   * Dispatch a set of chunks as an atomic batch (for build operations).
   * All mesh results are applied together in one frame.
   */
  dispatchBatch(keys: Set<string>): void {
    const batchItems: Array<{
      chunkKey: string;
      grid: Uint16Array;
      skipHighBoundary: [boolean, boolean, boolean];
    }> = [];

    for (const key of keys) {
      const chunk = this.chunks.get(key);
      if (!chunk) continue;
      this.queue.delete(key);
      const grid = this.meshPool.takeGrid();
      const skipHighBoundary = expandChunkToGrid(chunk, this.chunks, grid);
      batchItems.push({ chunkKey: key, grid, skipHighBoundary });
    }

    if (batchItems.length === 0) return;

    this.meshPool.dispatchBatch(batchItems, (results) => {
      for (const result of results) this.applyResult(result);
    });
  }

  /** Check if a chunk key is busy (in queue or in-flight on worker). */
  isBusy(key: string): boolean {
    return this.queue.has(key) || this.meshPool.isInFlight(key);
  }

  // ---- Private ----

  /** Apply a worker result: update geometry, register with grouper, notify listeners. */
  private applyResult(result: MeshResult): void {
    const { chunkKey: key, solid, transparent, liquid } = result;
    const chunk = this.chunks.get(key);
    if (!chunk) return;

    let geo = this.geometries.get(key);
    if (!geo) {
      geo = new ChunkGeometry(chunk);
      this.geometries.set(key, geo);
    }

    geo.updateFromData(solid, transparent, liquid);
    chunk.clearDirty();
    this.registerWithGrouper(key, chunk, geo);

    for (const listener of this.listeners) listener(key);
  }

  /** Register chunk geometry with the grouper for merged rendering. */
  private registerWithGrouper(key: string, chunk: Chunk, geo: ChunkGeometry): void {
    const worldPos = chunk.getWorldPosition();
    this.grouper.updateChunk(key, chunk.cx, chunk.cy, chunk.cz, geo.getGeometries(), worldPos);
  }

  /**
   * Check if any positive-face neighbor (+X, +Y, +Z) is still pending.
   * Only these 3 supply margin data for this chunk's mesh.
   */
  private hasNeighborsPending(cx: number, cy: number, cz: number): boolean {
    for (const [dx, dy, dz] of POSITIVE_FACE_OFFSETS_3) {
      if (this.pendingChunks.has(chunkKey(cx + dx, cy + dy, cz + dz))) return true;
    }
    return false;
  }
}
