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
  private chunks: Map<string, Chunk>;
  private geometries: Map<string, ChunkGeometry>;
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

  /**
   * True when a chunk should be meshed NOW — i.e. it is on-screen or one ring inside the render
   * frontier (reachable ∪ face-ring, the same set the render gate draws). Chunks that are loaded only
   * to supply neighbour VOXELS as margin sources — the occluder shell, and the underground bulk behind
   * rock the visibility BFS never reaches — return false: meshing them is pure waste (they never draw).
   * They stay queued and mesh the moment the player's view reaches them (process runs every frame).
   * Injected by VoxelWorld (which owns the reachable set); defaults to "mesh everything" when omitted.
   */
  private readonly shouldMeshNow: (cx: number, cy: number, cz: number) => boolean;

  /**
   * Derive mesh COMPLETENESS from "is a high FACE neighbour still expected to load" rather than from
   * the mesher's skipHighBoundary flags. Set for the coarse rings: a chunk is only ever dispatched once
   * marginSourcesReady (nothing inbound), so any high face the mesher still skips is a neighbour that
   * will NEVER load — underground rock below a column's minCy, or beyond the request band — where the
   * edge is extrapolated to the correct solid and the mesh is final. Treating those as INCOMPLETE (the
   * skipHighBoundary default) hid legitimate ring-edge surface chunks forever, since no late arrival
   * ever heals them. The base keeps the skipHighBoundary derivation: it meshes chunks with genuinely
   * absent neighbours on purpose and relies on the P8 re-mesh heal when one arrives late.
   */
  private readonly completeFromExpected: boolean;

  constructor(
    chunks: Map<string, Chunk>,
    geometries: Map<string, ChunkGeometry>,
    grouper: ChunkGrouper,
    meshPool: MeshWorkerPool,
    pendingChunks: Set<string>,
    isMarginSourceExpected?: (cx: number, cy: number, cz: number) => boolean,
    shouldMeshNow?: (cx: number, cy: number, cz: number) => boolean,
    completeFromExpected = false,
  ) {
    this.chunks = chunks;
    this.geometries = geometries;
    this.grouper = grouper;
    this.meshPool = meshPool;
    this.pendingChunks = pendingChunks;
    this.isMarginSourceExpected = isMarginSourceExpected
      ?? ((cx, cy, cz) => this.pendingChunks.has(chunkKey(cx, cy, cz)));
    this.shouldMeshNow = shouldMeshNow ?? (() => true);
    this.completeFromExpected = completeFromExpected;
  }

  /** Repoint at the ACTIVE LOD level's chunk/geometry maps (VoxelWorld.activateLevel). The queue is
   *  cleared separately (clear()) on a level change, so no stale keys carry across. */
  setMaps(chunks: Map<string, Chunk>, geometries: Map<string, ChunkGeometry>): void {
    this.chunks = chunks;
    this.geometries = geometries;
  }

  // ---- Listeners ----

  addListener(fn: RemeshListener): void { this.listeners.add(fn); }
  removeListener(fn: RemeshListener): void { this.listeners.delete(fn); }

  // ---- Queue management ----

  add(key: string): void { this.queue.add(key); }
  delete(key: string): void { this.queue.delete(key); }
  /**
   * Clear the queue AND bump the generation. Called on an LOD level change / world switch, when the
   * chunk map is cleared and re-populated. Mesh jobs are async: one dispatched from OLD voxel data
   * (its grid captured at dispatch) could return after the swap and apply onto the RE-USED chunk key,
   * writing wrong-scale geometry onto the new chunk (the flat-slab artifacts). Dispatch captures the
   * generation and applyResult drops results whose generation no longer matches.
   */
  clear(): void { this.queue.clear(); this.generation++; }
  get size(): number { return this.queue.size; }

  /**
   * True while mesh work that will actually PRODUCE geometry is still outstanding — i.e. a chunk is
   * dispatched to a worker (in-flight, result not yet applied) OR a queued chunk is dispatchable right now
   * (loaded, drawable per shouldMeshNow, margins ready). Crucially this is NOT `size > 0`: occluder-shell /
   * underground chunks are parked in the queue indefinitely by design (shouldMeshNow=false) and never
   * produce geometry, so counting them would make a resting coarse view look perpetually "busy". Used by
   * the LOD quiescence net so it won't force-drop retiring geometry while the new level's meshes are still
   * being produced (the fast-cache blank: generation finishes instantly, meshes are still in the pipeline).
   */
  hasPendingMeshWork(): boolean {
    if (this.meshPool.hasInFlight()) return true;   // dispatched → result pending → will draw
    for (const key of this.queue) {
      const chunk = this.chunks.get(key);
      if (!chunk) continue;
      if (this.meshPool.isInFlight(key) || this.meshPool.isPreviewChunk(key)) continue;
      if (!this.shouldMeshNow(chunk.cx, chunk.cy, chunk.cz)) continue;      // occluded → never draws
      if (!this.marginSourcesReady(chunk.cx, chunk.cy, chunk.cz)) continue; // waiting on a neighbour
      return true;   // a chunk that can mesh THIS frame → real work remains
    }
    return false;
  }

  /** Monotonic generation; bumped by clear() so stale async mesh results can be dropped on apply. */
  private generation = 0;

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
      // Don't spend a mesh-worker slot on a chunk that won't be drawn — the occluder shell / the
      // underground bulk behind rock. Left in the queue (not deleted): it meshes the frame the
      // player's view reaches it, since process() runs every frame and re-tests this.
      if (!this.shouldMeshNow(chunk.cx, chunk.cy, chunk.cz)) continue;
      if (!this.marginSourcesReady(chunk.cx, chunk.cy, chunk.cz)) continue;

      const grid = this.meshPool.takeGrid();
      const skipHighBoundary = expandChunkToGrid(chunk, this.chunks, grid);
      // Coarse rings: complete unless a high FACE neighbour is still inbound (see completeFromExpected).
      // Base: complete unless the mesher had to skip a high face (absent neighbour), healed later by P8.
      const complete = this.completeFromExpected
        ? !(this.isMarginSourceExpected(chunk.cx + 1, chunk.cy, chunk.cz)
            || this.isMarginSourceExpected(chunk.cx, chunk.cy + 1, chunk.cz)
            || this.isMarginSourceExpected(chunk.cx, chunk.cy, chunk.cz + 1))
        : !(skipHighBoundary[0] || skipHighBoundary[1] || skipHighBoundary[2]);

      const gen = this.generation;
      this.meshPool.dispatch(key, grid, skipHighBoundary, (result) => {
        if (gen !== this.generation) return;   // level/world changed since dispatch → stale, drop
        this.setComplete(key, complete);
        this.applyResult(result);
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

    const gen = this.generation;
    this.meshPool.dispatchBatch(batchItems, (results) => {
      if (gen !== this.generation) return;   // level/world changed since dispatch → stale, drop
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
    this.grouper.updateChunk(key, chunk.cx, chunk.cy, chunk.cz, chunk.level, geo.getGeometries(), worldPos);
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
