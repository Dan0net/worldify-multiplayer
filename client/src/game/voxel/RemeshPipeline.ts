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
  POSITIVE_MARGIN_OFFSETS_7,
  chunkKey,
} from '@worldify/shared';
import { Chunk, ChunkPhase } from './Chunk.js';
import { ChunkGeometry } from './ChunkGeometry.js';
import { ChunkGrouper } from './ChunkGrouper.js';
import { meshChunk, expandChunkToGrid, getSkipHighBoundary } from './ChunkMesher.js';
import { MeshWorkerPool, type MeshResult } from './MeshWorkerPool.js';
import { chunkProfiler } from '../debug/ChunkProfiler.js';

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

  /** Cumulative count of mesh-worker dispatches — a churn gauge for streaming (surfaced in perf). */
  meshDispatches = 0;


  // ---- Dependencies (injected) ----
  private readonly chunks: Map<string, Chunk>;
  private readonly geometries: Map<string, ChunkGeometry>;
  private readonly grouper: ChunkGrouper;
  private readonly meshPool: MeshWorkerPool;
  private readonly pendingChunks: Set<string>;

  /**
   * True when the positive margin-source neighbour at (cx,cy,cz) is EXPECTED to load but isn't ready
   * yet — meshing should wait for it so a chunk's border is built once with real data instead of
   * extrapolated-now / re-meshed-later. Injected by VoxelWorld (which knows loaded / pending /
   * reachable / empty-air). Defaults to a pending-only check when omitted.
   */
  private readonly isMarginSourceExpected: (cx: number, cy: number, cz: number) => boolean;

  constructor(
    chunks: Map<string, Chunk>,
    geometries: Map<string, ChunkGeometry>,
    grouper: ChunkGrouper,
    meshPool: MeshWorkerPool,
    pendingChunks: Set<string>,
    isMarginSourceExpected?: (cx: number, cy: number, cz: number) => boolean,
  ) {
    this.chunks = chunks;
    this.geometries = geometries;
    this.grouper = grouper;
    this.meshPool = meshPool;
    this.pendingChunks = pendingChunks;
    this.isMarginSourceExpected = isMarginSourceExpected
      ?? ((cx, cy, cz) => this.pendingChunks.has(chunkKey(cx, cy, cz)));
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
      if (!this.marginSourcesReady(chunk.cx, chunk.cy, chunk.cz)) continue;

      const grid = this.meshPool.takeGrid();
      const skipHighBoundary = expandChunkToGrid(chunk, this.chunks, grid);
      const complete = !(skipHighBoundary[0] || skipHighBoundary[1] || skipHighBoundary[2]);

      chunkProfiler.onMeshDispatch(key);
      this.meshPool.dispatch(key, grid, skipHighBoundary, (result) => {
        this.setComplete(key, complete);
        this.applyResult(result);
        chunkProfiler.onMeshApplied(key);
      });
      this.meshDispatches++;

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

    const skip = getSkipHighBoundary(chunk, this.chunks);
    this.setComplete(key, !(skip[0] || skip[1] || skip[2]));
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
      grid: Uint32Array;
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
      for (const result of results) {
        const item = batchItems.find((b) => b.chunkKey === result.chunkKey);
        if (item) {
          const s = item.skipHighBoundary;
          this.setComplete(result.chunkKey, !(s[0] || s[1] || s[2]));
        }
        this.applyResult(result);
      }
    });
  }

  /** Check if a chunk key is busy (in queue or in-flight on worker). */
  isBusy(key: string): boolean {
    return this.queue.has(key) || this.meshPool.isInFlight(key);
  }

  /**
   * True unless this chunk's applied mesh skipped a high boundary (absent + margin neighbour). A
   * never-meshed chunk reports complete — it has no geometry, so the render pass skips it anyway; the
   * flag only matters once a mesh exists. Consumed by the render gate to keep holed meshes off screen.
   * Source of truth is the chunk's own `phase` (dies with the chunk — no forget-on-unload contract).
   */
  isMeshComplete(key: string): boolean {
    const chunk = this.chunks.get(key);
    return !chunk || chunk.phase !== ChunkPhase.MeshedIncomplete;
  }

  /** Record whether a chunk's just-applied mesh built all its high faces, on the chunk's phase. */
  private setComplete(key: string, complete: boolean): void {
    const chunk = this.chunks.get(key);
    if (chunk) chunk.phase = complete ? ChunkPhase.MeshedComplete : ChunkPhase.MeshedIncomplete;
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
   * True once every positive margin source is resolved — loaded, or confirmed not-coming — so the
   * chunk can mesh its high-side border ONCE with real neighbour data. A mesh's high-side margin is
   * filled from all 7 positive neighbours (+X/+Y/+Z faces, edges, corner — see expandChunkData); we
   * defer while any is still EXPECTED to load (pending or reachable-but-unloaded, per
   * isMarginSourceExpected), which turns "mesh extrapolated now → re-mesh when the neighbour arrives"
   * into a single mesh. The dependency only points +XYZ, so it terminates at the frontier (no cycles):
   * the outermost chunks — whose + neighbours aren't coming — mesh first and readiness cascades inward.
   */
  private marginSourcesReady(cx: number, cy: number, cz: number): boolean {
    for (const [dx, dy, dz] of POSITIVE_MARGIN_OFFSETS_7) {
      if (this.isMarginSourceExpected(cx + dx, cy + dy, cz + dz)) return false;
    }
    return true;
  }
}
