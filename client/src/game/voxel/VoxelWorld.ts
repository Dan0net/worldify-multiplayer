/**
 * VoxelWorld - Manages chunk loading/unloading around the player
 */

import * as THREE from 'three';
import {
  VISIBILITY_RADIUS,
  VISIBILITY_UNLOAD_BUFFER,
  CHUNK_SIZE,
  CHUNK_WORLD_SIZE,
  FACE_OFFSETS_6,
  NEGATIVE_MARGIN_OFFSETS_7,
  POSITIVE_MARGIN_OFFSETS_7,
  REQUEST_TIMEOUT_MS,
  MSG_VOXEL_CHUNK_REQUEST,
  MSG_MAP_TILE_REQUEST,
  MSG_SURFACE_COLUMN_REQUEST,
  worldToChunk,
  chunkKey,
  parseChunkKey,
  BuildOperation,
  getAffectedChunks,
  drawToChunk,
  VoxelChunkData,
  RequestNack,
  encodeVoxelChunkRequest,
  encodeSurfaceColumnRequest,
  encodeMapTileRequest,
  SurfaceColumnResponse,
  MapTileResponse,
  computeVisibility,
  getChunkRangeFromHeights,
  getSunlitAbove,
  computeAndPropagateLight,
  faceDonatesLight,
  relightRegion,
  type RelightTarget,
  chunkHasEmitter,
  chunkHasBlockLight,
} from '@worldify/shared';
import { Chunk, ChunkPhase } from './Chunk.js';
import { ChunkGeometry } from './ChunkGeometry.js';
import { ChunkGrouper } from './ChunkGrouper.js';
import { RemeshPipeline } from './RemeshPipeline.js';
import { MeshWorkerPool, meshWorkerCount } from './MeshWorkerPool.js';
import { expandChunkToGrid, setEmptyAirPredicate } from './ChunkMesher.js';
import { resampleLightAttributes } from './MeshGeometry.js';
import { sendBinary } from '../../net/netClient.js';
import { useGameStore } from '../../state/store.js';
import { perfStats } from '../debug/PerformanceStats.js';
import {
  getVisibleChunks,
  getFrustumFromCamera,
  getCameraDirection,
  type ChunkProvider,
} from './VisibilityBFS.js';
import { TerrainWorkerPool, terrainWorkerCount } from './TerrainWorkerPool.js';
import { SeamStitcher } from './SeamStitcher.js';
import { getActiveWorldSeed, getActiveWorldCaveConfig, getActiveWorldTerrainConfig, hasChunk, loadChunk, saveChunk, hasColumn, loadColumn, saveColumn, pushUndo, popUndo, type ChunkSnapshot } from '../world/WorldManager.js';

/** Callback type for requesting chunk data from server */
export type ChunkRequestFn = (cx: number, cy: number, cz: number) => void;

/**
 * Chunk-Y range for a column from its (stamp-corrected) heights.
 * - maxCy: topmost chunk to LOAD, from maxHeight + 1 — the top face of the highest solid voxel is
 *   meshed from the voxel ABOVE it, so a flat top flush with a chunk's top row (localY 31) needs the
 *   next chunk up loaded to supply the air margin (else the extrapolated margin repeats the solid
 *   voxel and the top face is culled → flat roofs clipped). Non-flush tops resolve to their own chunk.
 * - minCy: chunk of the LOWEST surface point. Chunks strictly below it are fully underground (no open
 *   sky anywhere in the footprint), so they may safely default to dark when the chunk above isn't
 *   loaded. Surface chunks (slopes, flush tops, BFS-edge columns) are at cy >= minCy and stay lit.
 */
function columnChunkRange(heights: ArrayLike<number>, level = 0): { minCy: number; maxCy: number } {
  // `heights` are TRUE-world voxel surface heights at every level. A level-L chunk spans
  // CHUNK_SIZE·2^L world-voxels vertically (matching generateChunk's chunkWorldY = cy·CHUNK_SIZE·2^L
  // and buildSurfaceColumn's span), so the level-LOCAL chunk index is height / (CHUNK_SIZE·2^L). Dividing
  // by CHUNK_SIZE alone (the old code) inflated maxCy by 2^L at coarse zoom, so the visibility BFS
  // centred and its air/terrain test landed 2^L chunks above the real surface — coarse chunks streamed
  // and meshed but the BFS never marked them visible, so nothing rendered. level 0 (span = CHUNK_SIZE)
  // is unchanged.
  const span = CHUNK_SIZE << level;
  const { minHeight, maxHeight } = getChunkRangeFromHeights(heights);
  return { minCy: Math.floor(minHeight / span), maxCy: Math.floor((maxHeight + 1) / span) };
}

/** Shared read-only all-dark "light from above" (used for underground chunks with no chunk above
 *  loaded, so caves aren't lit as open sky). Never mutated — the sunlight pass only reads it. */
const DARK_ABOVE = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);


/** Fast typed-array equality check (same length assumed). */
function arraysEqual(a: Uint32Array, b: Uint32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Manages the voxel world - chunk loading, unloading, and streaming.
 */
export class VoxelWorld implements ChunkProvider {
  /** All loaded chunks, keyed by "cx,cy,cz" */
  readonly chunks: Map<string, Chunk> = new Map();

  /** All chunk geometries, keyed by "cx,cy,cz" */
  readonly geometries: Map<string, ChunkGeometry> = new Map();

  /** Chunk keys currently in build preview (set by BuildPreview, read by visibility) */
  readonly previewChunks: Set<string> = new Set();

  /** Chunks pending data from server, keyed by "cx,cy,cz" */
  private pendingChunks: Set<string> = new Set();

  /** Columns pending data from server, keyed by "tx,tz" */
  private pendingColumns: Set<string> = new Set();

  /** Tiles pending from server, keyed by "tx,tz" */
  private pendingTiles: Set<string> = new Set();

  /** Timestamps for pending requests (keyed same as their pending sets) */
  private pendingChunkTimes: Map<string, number> = new Map();
  private pendingColumnTimes: Map<string, number> = new Map();
  private pendingTileTimes: Map<string, number> = new Map();

  /** Column info from received tiles. maxCy = top chunk to load (stamp-inclusive, highest surface
   *  point). minCy = chunk of the LOWEST surface point — chunks below it are fully underground.
   *  Keyed by "tx,tz". */
  private columnInfo: Map<string, { maxCy: number; minCy: number }> = new Map();

  /** Local terrain generation worker pool (offline mode). Created lazily. */
  private localPool: TerrainWorkerPool | null = null;

  /** Callback to notify external systems (e.g. map cache) when a tile arrives */
  onTileReceived: ((tx: number, tz: number, heights: Int16Array, materials: Uint8Array) => void) | null = null;

  /**
   * Callback fired when a chunk's voxel data is (re)ingested — i.e. real
   * generated/streamed content, including procedural stamps (trees/rocks/
   * buildings). Lets the minimap refresh from actual chunks, not just the
   * stamp-free terrain baseline. Not fired on identical no-op re-sends.
   */
  onChunkIngested: ((chunkKey: string) => void) | null = null;

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

  /** Build operations deferred until all affected chunks are loaded */
  private deferredBuildOps: Array<{ operation: BuildOperation; affectedKeys: string[] }> = [];

  /** Whether the world has been initialized */
  private initialized = false;

  /** Dynamic visibility radius (defaults to shared constant, overridden by quality settings) */
  private _visibilityRadius: number = VISIBILITY_RADIUS;

  /**
   * Set when inputs to updateMeshVisibility() change (new geometry,
   * unloaded chunks, preview changes).  Cleared after each full scan.
   * The BFS chunkChanged flag is handled separately.
   */
  private visibilityDirty = true;

  /** Worker pool for off-thread mesh generation */
  readonly meshPool: MeshWorkerPool;

  /** Groups chunk geometries into spatial buckets for draw-call reduction */
  readonly chunkGrouper: ChunkGrouper;

  /** Manages remesh queue and worker dispatch */
  readonly remeshPipeline: RemeshPipeline;

  /** Reconciles vertex normals across chunk-mesh seams. */
  readonly seamStitcher: SeamStitcher;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.meshPool = new MeshWorkerPool(meshWorkerCount());
    this.chunkGrouper = new ChunkGrouper(scene);
    this.remeshPipeline = new RemeshPipeline(
      this.chunks,
      this.geometries,
      this.chunkGrouper,
      this.meshPool,
      this.pendingChunks,
      (cx, cy, cz) => this.isMarginSourceExpected(cx, cy, cz),
      (cx, cy, cz) => this.shouldMeshChunk(cx, cy, cz),
    );
    // Let the mesher distinguish open sky from not-yet-loaded, so terrain tops that meet a chunk
    // boundary against sky mesh against air (capped) instead of being skipped/extrapolated → no gap.
    setEmptyAirPredicate((cx, cy, cz) => this.isEmptyAir(cx, cy, cz));
    this.seamStitcher = new SeamStitcher(this.geometries, (ck) => {
      const gk = this.chunkGrouper.getGroupKey(ck);
      if (gk) this.chunkGrouper.markGroupDirty(gk);
    });

    // New/updated geometry may need its visibility evaluated, invalidates the cached
    // mesh count (polled every frame for the debug overlay), and its seams need
    // reconciling with neighbors.
    this.remeshPipeline.addListener((key) => {
      this.visibilityDirty = true;
      this.meshCountDirty = true;
      this.seamStitcher.enqueue(key);
    });
  }

  /** Cached count of chunks with visible geometry (recomputed only when dirty). */
  private cachedMeshCount = 0;
  private meshCountDirty = true;

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
    this.remeshPipeline.addListener(listener);
  }

  /**
   * Remove a previously registered remesh listener.
   */
  removeRemeshListener(listener: (chunkKey: string) => void): void {
    this.remeshPipeline.removeListener(listener);
  }

  /**
   * Mark visibility as dirty so the next update rescans all geometries.
   * Call when external state that affects visibility changes (e.g. previewChunks).
   */
  markVisibilityDirty(): void {
    this.visibilityDirty = true;
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
  // ---- LOD zoom (Explore) ----
  /** Current LOD zoom level (0 = full detail / play). Coarse levels sample the same world at a 2^L
   *  step; every chunk/tile/column request carries it, and the grouper root is scaled by 2^L. */
  private currentLevel = 0;
  /** Use a Chebyshev (cube) visibility volume instead of the L1 diamond — set in Explore so every
   *  level always has a full shell of chunks to swap in/out on a level change. */
  private cubeVisibility = false;
  /** Scratch stream centre: horizontal from the caller, vertical pinned to the surface in Explore. */
  private _streamPos = new THREE.Vector3();

  get lodLevel(): number { return this.currentLevel; }

  /** Toggle the cube (square) visibility volume — Explore uses it, play keeps the diamond. */
  setCubeVisibility(cube: boolean): void {
    if (cube === this.cubeVisibility) return;
    this.cubeVisibility = cube;
    this.lastBFSChunk = null;
    this.visibilityDirty = true;
  }

  /**
   * Change the Explore LOD zoom level (per-chunk hold-then-swap). Retires the current level's visible
   * chunks into the grouper's retiring holder (kept fully visible at the old scale), installs a fresh
   * terrain root scaled by 2^level, and clears the live chunk state so the world re-streams at the new
   * level (all requests now carry it). The retiring chunks are disposed INDIVIDUALLY as the new level
   * resolves their world regions (reconcileRetiring in update) — never a blank frame. `center` is the
   * level-LOCAL stream centre.
   */
  setExploreLevel(level: number, center?: THREE.Vector3): void {
    if (level === this.currentLevel) return;
    // Clone the currently-visible chunks into the retiring holder (old scale) BEFORE disposing the
    // per-chunk geometries below — the holder owns independent clones, so the disposal is safe.
    this.chunkGrouper.retireAndReset(1 << level, 1 << this.currentLevel);
    this.currentLevel = level;

    // Clear live chunk state. The grouper's live root was already reset by retireAndReset; the retiring
    // holder keeps the old level visible until its per-chunk clones are swapped out.
    for (const geo of this.geometries.values()) geo.dispose();
    this.geometries.clear();
    this.chunks.clear();
    this.pendingChunks.clear(); this.pendingColumns.clear(); this.pendingTiles.clear();
    this.pendingChunkTimes.clear(); this.pendingColumnTimes.clear(); this.pendingTileTimes.clear();
    this.columnInfo.clear();
    this.remeshPipeline.clear();
    this.deferredBuildOps.length = 0;
    this.previewChunks.clear();
    this.lastPlayerChunk = null;
    this.lastBFSChunk = null;
    this.initialColumnRequested = false;
    this.visibilityDirty = true;
    this.initialized = true;
    if (center) this.update(center);
  }

  /**
   * Coverage predicate for the per-chunk LOD retire-and-swap. Given a retiring (old-level) chunk's
   * TRUE-world AABB, return true once the NEW level has RESOLVED every cell of that region — i.e. it's
   * safe to drop the old chunk without leaving a gap. A new-level cell is resolved when it is:
   *   - genuine empty sky (nothing will ever render there), OR
   *   - not part of the incoming view (out of the reachable set and not pending — e.g. zoom-in
   *     periphery that the smaller new view won't load), OR
   *   - already meshed (phase past Loaded — has geometry, or meshed-empty).
   * Only an in-view, expected-but-not-yet-meshed cell blocks disposal, so the old chunk survives
   * exactly until its replacement is drawable.
   */
  private retiringResolved(box: THREE.Box3): boolean {
    const span = CHUNK_WORLD_SIZE * (1 << this.currentLevel);   // true-world size of a new-level chunk
    const cxMin = Math.floor(box.min.x / span), cxMax = Math.floor((box.max.x - 1e-3) / span);
    const cyMin = Math.floor(box.min.y / span), cyMax = Math.floor((box.max.y - 1e-3) / span);
    const czMin = Math.floor(box.min.z / span), czMax = Math.floor((box.max.z - 1e-3) / span);
    for (let cx = cxMin; cx <= cxMax; cx++) {
      for (let cy = cyMin; cy <= cyMax; cy++) {
        for (let cz = czMin; cz <= czMax; cz++) {
          if (this.isEmptyAir(cx, cy, cz)) continue;              // air — nothing renders here
          const key = chunkKey(cx, cy, cz);
          if (!this.cachedReachable.has(key) && !this.pendingChunks.has(key)) continue; // not incoming
          const chunk = this.chunks.get(key);
          if (chunk && chunk.phase !== ChunkPhase.Loaded) continue; // meshed (complete or empty)
          return false;   // in view, expected, not yet meshed → keep holding this old chunk
        }
      }
    }
    return true;
  }

  setVisibilityRadius(radius: number): void {
    if (radius === this._visibilityRadius) return;
    this._visibilityRadius = radius;
    // Invalidate BFS cache and force a mesh-visibility/unload rescan so the
    // change takes effect immediately even when the player isn't moving.
    this.lastBFSChunk = null;
    this.visibilityDirty = true;
    console.log(`[VoxelWorld] Visibility radius set to ${radius}`);
  }

  get visibilityRadius(): number {
    return this._visibilityRadius;
  }

  // ---- Stale pending request cleanup ----

  /**
   * Remove entries from a pending set whose timestamps exceed REQUEST_TIMEOUT_MS.
   * Returns true if any entries were cleaned (caller may want to invalidate BFS).
   */
  private expireStale(pending: Set<string>, timestamps: Map<string, number>, now: number): boolean {
    let cleaned = false;
    for (const [key, time] of timestamps) {
      if (now - time > REQUEST_TIMEOUT_MS) {
        pending.delete(key);
        timestamps.delete(key);
        cleaned = true;
      }
    }
    return cleaned;
  }

  /**
   * Sweep all pending sets for stale entries.
   * Called once per update() before BFS so freed slots are available for new requests.
   */
  private cleanStalePending(): void {
    const now = Date.now();
    const hadStaleChunks = this.expireStale(this.pendingChunks, this.pendingChunkTimes, now);
    const hadStaleTiles = this.expireStale(this.pendingTiles, this.pendingTileTimes, now);
    const hadStaleColumns = this.expireStale(this.pendingColumns, this.pendingColumnTimes, now);

    if (hadStaleChunks || hadStaleTiles || hadStaleColumns) {
      // Invalidate BFS so next cycle re-discovers and re-requests
      this.lastBFSChunk = null;

      // If the initial surface column timed out, allow re-request
      if (hadStaleColumns && this.pendingColumns.size === 0 && this.columnInfo.size === 0) {
        this.initialColumnRequested = false;
      }
    }
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
   * ChunkProvider interface — true ONLY for genuine open sky (above the column's content top), where
   * no voxel data exists and none will ever load. Lets the visibility BFS traverse through empty sky
   * to reach terrain beyond it, while unloaded terrain (cy <= maxCy) and unknown columns (no tile
   * yet) return false so they must load before being traversed — we never see through unloaded rock.
   */
  isEmptyAir(cx: number, cy: number, cz: number): boolean {
    const info = this.columnInfo.get(`${cx},${cz}`);
    return info ? cy > info.maxCy : false;
  }

  /**
   * P4 mesh-readiness: is this positive margin-source neighbour EXPECTED to load but not here yet?
   * If so, the consumer should defer meshing so its high-side border is built once with real voxels
   * instead of extrapolated-now / re-meshed-when-it-arrives.
   *   - loaded            → not expected (ready to use)
   *   - genuine open sky   → never loads (extrapolation = air), ready
   *   - pending or reachable-but-unloaded → the BFS will bring it → EXPECTED, wait
   *   - anything else (not loaded, not void, not wanted) → not coming soon → ready (mesh now; P8's
   *     re-mesh trigger still corrects a rare late arrival)
   */
  private isMarginSourceExpected(cx: number, cy: number, cz: number): boolean {
    const key = chunkKey(cx, cy, cz);
    if (this.chunks.has(key)) return false;
    if (this.isEmptyAir(cx, cy, cz)) return false;
    return this.pendingChunks.has(key) || this.cachedReachable.has(key);
  }

  /**
   * Update the world based on player position.
   * Uses visibility BFS for loading and rendering.
   * @param playerPos Player world position
   */
  update(playerPos: THREE.Vector3): void {
    if (!this.initialized) return;

    // Reconcile seam normals for chunks meshed since last frame, BEFORE the grouper
    // re-bakes normals into merged buffers (updateWithVisibility → chunkGrouper.rebuild).
    this.seamStitcher.flush();

    // Stream centre. In Explore, PIN THE VERTICAL to the surface of the centre column (from the loaded
    // column range) — the orbit target's Y can sit below the surface (a fresh landform world at origin,
    // or returning from a zoomed-out level), which would centre the BFS underground in unloaded solid
    // where it can't traverse up to the surface, so nothing loads until the user taps the ground. The
    // horizontal centre still follows the caller. maxCy is just above the surface (air side), so the BFS
    // reliably floods DOWN through air onto the terrain. In Play (cubeVisibility off) the real position
    // is used unchanged (the player may legitimately be underground/in a cave).
    this._streamPos.copy(playerPos);
    if (this.cubeVisibility) {
      const pc = worldToChunk(playerPos.x, playerPos.y, playerPos.z);
      const ci = this.columnInfo.get(`${pc.cx},${pc.cz}`);
      if (ci) this._streamPos.y = (ci.maxCy + 0.5) * CHUNK_WORLD_SIZE;
    }

    // Get player's current chunk (from the surface-pinned stream position in Explore)
    const playerChunk = worldToChunk(this._streamPos.x, this._streamPos.y, this._streamPos.z);
    this.lastPlayerChunk = { ...playerChunk };

    // Expire stale pending requests so they can be re-requested
    this.cleanStalePending();

    // Use visibility-based loading
    this.updateWithVisibility(playerChunk, this._streamPos);

    // Per-chunk LOD swap: drop each retiring (old-level) chunk once the new level has resolved its
    // world region. No-op when no level transition is in flight.
    this.chunkGrouper.reconcileRetiring((box) => this.retiringResolved(box));

    // Dispatch from remesh queue to workers (async meshing)
    perfStats.begin('remesh');
    const priorityKeys = this.chunkGrouper.getPriorityChunkKeys();
    this.remeshPipeline.process(this._streamPos, priorityKeys.size > 0 ? priorityKeys : undefined);
    perfStats.end('remesh');

    // Report queue stats for debug overlay
    perfStats.setVoxelQueueStats(this.remeshPipeline.size, this.pendingChunks.size);
    perfStats.setMeshDispatches(this.remeshPipeline.meshDispatches);
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

    // Check if player moved to a new chunk.
    const chunkChanged = !this.lastBFSChunk ||
      playerChunk.cx !== this.lastBFSChunk.cx ||
      playerChunk.cy !== this.lastBFSChunk.cy ||
      playerChunk.cz !== this.lastBFSChunk.cz;

    // Recompute the visibility BFS when the player crosses a chunk OR the frontier changes (a chunk
    // was meshed / removed, flagged via visibilityDirty). The BFS only traverses through LOADED
    // chunks, so each newly-streamed chunk extends the reachable set by a ring — re-running on
    // frontier change (not only on chunk-cross) is what lets a chunk become visible the moment it
    // loads, instead of waiting for the next cross. Cheap: a zero-alloc typed-array BFS over the
    // radius, and only on frames where the player moved or geometry actually changed.
    if (chunkChanged || this.visibilityDirty) {
      if (chunkChanged) this.lastBFSChunk = { ...playerChunk };

      const frustum = getFrustumFromCamera(this.camera);
      const cameraDir = getCameraDirection(this.camera);
      const { reachable, toRequest } = getVisibleChunks(
        playerChunk,
        cameraDir,
        frustum,
        this,
        this._visibilityRadius,
        playerPos,
        this.cubeVisibility,
      );
      this.cachedReachable = reachable;
      this.addMarginSourceRequests(reachable, toRequest);
      this.requestVisibleChunks(toRequest, playerPos);

      this.updateMeshVisibility(this.cachedReachable);
      this.visibilityDirty = false;
    }

    // Rebuild merged terrain groups (only dirty groups are re-merged).
    // Skip groups that still have chunks in the remesh queue or in-flight on workers
    // to avoid rebuilding the same group dozens of times during loading.
    if (this.lastPlayerChunk) {
      const { cx, cy, cz } = this.lastPlayerChunk;
      perfStats.begin('grouper');
      this.chunkGrouper.rebuild(cx, cy, cz, (key) => this.remeshPipeline.isBusy(key));
      perfStats.end('grouper');
      const gs = this.chunkGrouper.getRebuildStats();
      perfStats.setGrouperStats(gs.rebuilt, gs.reallocs);
    }

    // Unload chunks far outside reachable set (with +2 hysteresis buffer)
    this.unloadDistantChunks(this.cachedReachable);

    this.assertChunkInvariants();
  }

  /**
   * DEV-only cross-projection invariant checks (drift-doc guardrail #4). Run after each visibility
   * update: a violation means two per-chunk representations have drifted apart — the class of bug this
   * codebase keeps producing (a rendered chunk with no data, a pending set out of sync with its time
   * map, geometry left behind after unload). Non-fatal (console.error) so dev keeps running but loud;
   * `import.meta.env.DEV` strips the whole method body from production builds.
   */
  private assertChunkInvariants(): void {
    if (!import.meta.env.DEV) return;
    const fail = (msg: string): void => console.error(`[chunk-invariant] ${msg}`);

    // Orphan geometry: every meshed chunk must still be loaded. unloadChunk removes from the grouper
    // and disposes geometry BEFORE deleting the chunk, so after an update this must hold.
    for (const key of this.geometries.keys()) {
      if (!this.chunks.has(key)) fail(`geometry without a loaded chunk: ${key}`);
    }
    // A build-preview chunk must have loaded voxel data.
    for (const key of this.previewChunks) {
      if (!this.chunks.has(key)) fail(`preview chunk not loaded: ${key}`);
    }
    // Each pending* set and its stale-expiry time map are hand-paired at ~6 sites; keep them in lockstep.
    const pending: Array<[string, Set<string>, Map<string, number>]> = [
      ['pendingChunks', this.pendingChunks, this.pendingChunkTimes],
      ['pendingColumns', this.pendingColumns, this.pendingColumnTimes],
      ['pendingTiles', this.pendingTiles, this.pendingTileTimes],
    ];
    for (const [name, set, times] of pending) {
      if (set.size !== times.size) fail(`${name} size ${set.size} != times size ${times.size}`);
      for (const k of set) if (!times.has(k)) fail(`${name} key ${k} has no time entry`);
    }
  }

  /**
   * Request initial surface column to bootstrap the world.
   */
  private requestInitialSurfaceColumn(tx: number, tz: number): void {
    const columnKey = `${tx},${tz}`;
    if (this.pendingColumns.has(columnKey)) return;
    
    this.pendingColumns.add(columnKey);
    this.pendingColumnTimes.set(columnKey, Date.now());
    this.initialColumnRequested = true;

    if (this.isLocal) {
      // Coarse LOD levels bypass persistence (keys collide with level 0; cheap to regenerate).
      if (this.currentLevel > 0) {
        this.getLocalPool().requestColumn(tx, tz, (data) => this.handleLocalColumn(data), this.currentLevel);
        return;
      }
      // Existing world: heights are persisted, so seed columnInfo from IDB and skip the full worker
      // generateColumn (which would carve caves + stamps only to be discarded). The saved surface
      // chunks then stream in via the normal per-chunk load path (loadLocalChunk prefers saved).
      if (hasColumn(tx, tz)) {
        loadColumn(tx, tz).then((col) => {
          if (col) {
            this.pendingColumns.delete(columnKey);
            this.pendingColumnTimes.delete(columnKey);
            this.receiveTileData({ tx, tz, heights: col.heights, materials: col.materials });
          } else {
            this.getLocalPool().requestColumn(tx, tz, (data) => this.handleLocalColumn(data));
          }
        }).catch(() => this.getLocalPool().requestColumn(tx, tz, (data) => this.handleLocalColumn(data)));
        console.log(`[VoxelWorld] Seeded initial surface column from saved heights (${tx}, ${tz})`);
        return;
      }
      this.getLocalPool().requestColumn(tx, tz, (data) => this.handleLocalColumn(data));
      console.log(`[VoxelWorld] Requested initial surface column locally (${tx}, ${tz})`);
      return;
    }

    const request = encodeSurfaceColumnRequest({ tx, tz });
    sendBinary(request);
    console.log(`[VoxelWorld] Requested initial surface column (${tx}, ${tz})`);
  }

  /**
   * Request the 7 positive margin-source neighbours (+X/+Y/+Z faces, edges, corner) of every
   * reachable chunk. A rendered chunk's mesh reads those neighbours' voxels to place its high-side
   * border verts; the visibility BFS culls the ones behind opaque faces (occlusion is for SIGHT), but
   * their voxels are still needed to mesh the shared boundary — the source of the terrain gaps.
   * Loading them alongside the reachable frontier fixes the gaps AND shrinks the mesh-readiness wait
   * (a chunk's margins arrive with it, not a ring later). Bounded: one +ring around reachable, NO
   * cascade — we only ring reachable chunks, never the ring itself, so it can't flood-fill.
   */
  private addMarginSourceRequests(reachable: Set<string>, toRequest: Set<string>): void {
    const request = (nx: number, ny: number, nz: number) => {
      const nKey = chunkKey(nx, ny, nz);
      if (this.chunks.has(nKey) || this.pendingChunks.has(nKey)) return; // already have / coming
      if (this.isEmptyAir(nx, ny, nz)) return;                          // open sky, won't load
      toRequest.add(nKey);
    };
    for (const key of reachable) {
      const { cx, cy, cz } = parseChunkKey(key);
      // + margin sources: needed so a rendered chunk can mesh its OWN high faces (READ dependency).
      for (const [dx, dy, dz] of POSITIVE_MARGIN_OFFSETS_7) request(cx + dx, cy + dy, cz + dz);
      // − face neighbours: they OWN the surface on this chunk's low faces (boundary ownership — see the
      // chunk dependency contract), so they must load + render too or the render frontier's low sides
      // show a seam. Loading the full face ring keeps the load set one ring ahead of the render set.
      for (const [dx, dy, dz] of FACE_OFFSETS_6) request(cx + dx, cy + dy, cz + dz);
    }
  }

  /**
   * Request visible chunks (two-phase):
   * Phase 1: Request tiles for columns we don't know about yet
   * Phase 2: Request individual chunks for columns where we have tile data
   *
   * `toRequest` is the visibility BFS's own frontier — every unloaded chunk it reached. Loading is
   * driven ENTIRELY by this set (single source of truth: reachable = render set, toRequest = load
   * set, both from getVisibleChunks). The BFS steps to the immediate occluder walls one chunk past
   * visible air, so their voxels arrive as mesh margins without a separate stitch-loader. Chunks
   * above a column's maxCy are skipped (open sky, nothing to load).
   */
  private requestVisibleChunks(toRequest: Set<string>, playerPos?: THREE.Vector3): void {
    // In-flight request window, sized to the generation pool so every worker always has queued work
    // (a worker is only useful if the request layer keeps it fed). The old fixed 4 was the tightest
    // streaming throttle — with a core-scaled pool it left most workers idle and let a fast player
    // outrun loading. ~3× keeps a couple of jobs queued per worker; tiles are cheaper and fewer.
    const genCount = terrainWorkerCount();
    const MAX_PENDING_TILES = Math.max(4, genCount * 2);
    const MAX_PENDING_CHUNKS = genCount * 3;

    // Request NEAREST-FIRST. Only a few requests fit per call (throttle), so ordering decides what
    // loads now — and the margin-source loader appends occluded neighbours, which would otherwise sit
    // behind the whole frontier. Sort by distance to the player's FRACTIONAL chunk position (not just
    // the integer chunk), so the ordering tracks sub-chunk movement — otherwise it only refreshes on a
    // whole-chunk cross and a near chunk can wait behind a farther one for up to a chunk of travel.
    const pcx = playerPos ? playerPos.x / CHUNK_WORLD_SIZE : this.lastPlayerChunk?.cx;
    const pcy = playerPos ? playerPos.y / CHUNK_WORLD_SIZE : this.lastPlayerChunk?.cy;
    const pcz = playerPos ? playerPos.z / CHUNK_WORLD_SIZE : this.lastPlayerChunk?.cz;
    const sorted = [...toRequest];
    if (pcx !== undefined && pcy !== undefined && pcz !== undefined) {
      const dist = new Map<string, number>();
      for (const key of sorted) {
        const { cx, cy, cz } = parseChunkKey(key);
        dist.set(key, (cx - pcx) ** 2 + (cy - pcy) ** 2 + (cz - pcz) ** 2);
      }
      sorted.sort((a, b) => dist.get(a)! - dist.get(b)!);
    }

    // Phase 1: Identify columns that need tiles (nearest-first)
    const columnsNeedingTiles = new Set<string>();
    for (const key of sorted) {
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

    // Phase 2: Request chunks only for columns we have tile info for (nearest-first)
    let chunkRequests = 0;
    for (const key of sorted) {
      if (this.pendingChunks.size >= MAX_PENDING_CHUNKS) break;
      if (chunkRequests >= MAX_PENDING_CHUNKS) break;
      if (this.pendingChunks.has(key)) continue;
      
      const [cx, cy, cz] = key.split(',').map(Number);
      const columnKey = `${cx},${cz}`;
      const info = this.columnInfo.get(columnKey);
      
      // Don't request chunks for columns without tile data yet
      if (!info) continue;
      
      // Skip chunks above the surface. maxCy is the STAMP-INCLUSIVE top (the chunk holding the
      // highest tree/building voxel), so it's exactly right on its own — no margin, so no empty
      // sky chunk is loaded above the canopy. The top face meshes against extrapolated air.
      if (cy > info.maxCy) continue;
      
      this.requestChunkFromServer(cx, cy, cz);
      chunkRequests++;
    }
  }

  /**
   * Occlusion-cull rendered chunks against the visibility BFS: a chunk's merged group is shown ONLY
   * if the BFS reached it from the player (through connected openings, on a non-reversing path).
   * Everything else stays RESIDENT — loaded within the cube (see unloadDistantChunks) — but hidden,
   * so geometry behind solid rock, or around a corner the player can't see, doesn't draw. This is the
   * step that actually applies the visibility graph to what's on screen; loading uses the coarse cube,
   * rendering uses the reachable set.
   *
   * NOTE: We intentionally do NOT frustum-cull here. Three.js's built-in per-mesh frustum culling
   * tests each mesh against the active camera independently (main camera for the scene pass, light
   * camera for shadow maps). Manual culling against the main camera would hide chunks that still need
   * to cast shadows into view.
   */
  private updateMeshVisibility(reachable: Set<string>): void {
    for (const [key] of this.geometries) {
      // Preview chunks: their groups are suppressed and preview meshes render instead — never touch
      // their visibility here.
      if (this.previewChunks.has(key)) continue;
      this.chunkGrouper.setVisible(key, this.isRenderable(key, reachable));
    }
  }

  /**
   * Decide whether a chunk's mesh should be drawn this frame. Two gates:
   *
   * 1. COMPLETENESS — never draw a mesh that skipped a high boundary (a + margin neighbour was absent
   *    when it meshed), because that geometry has a hole on that face. It stays hidden until the
   *    neighbour streams in and it re-meshes complete. This is what keeps render ⊆ load − 1 ring: the
   *    outermost loaded (margin-shell) chunks are incomplete and hidden, so the visible frontier sits
   *    one ring inside the loaded region and never shows a "see through the world" seam.
   *
   * 2. VISIBILITY (one-ring dilation of `reachable`) — draw a chunk the BFS reached OR one sharing a
   *    face with a reached chunk. The per-chunk visibility graph is too coarse to gate by exactly: a
   *    surface chunk's air region often doesn't connect its solid-side faces, and the BFS only seeds
   *    all six faces from the camera chunk itself — so a chunk whose visible surface sits on a boundary
   *    with a reachable neighbour (e.g. the terrain directly below where you stand) is reached only
   *    when you're in the chunk beside it, and pops out the moment you cross away. Drawing the face-ring
   *    around `reachable` keeps that boundary geometry on screen from every adjacent position, while
   *    occlusion still hides anything two-or-more chunks deep behind a wall (the perf win).
   */
  private isRenderable(key: string, reachable: Set<string>): boolean {
    if (!this.remeshPipeline.isMeshComplete(key)) return false;
    if (reachable.has(key)) return true;
    const { cx, cy, cz } = parseChunkKey(key);
    for (const [dx, dy, dz] of FACE_OFFSETS_6) {
      if (reachable.has(chunkKey(cx + dx, cy + dy, cz + dz))) return true;
    }
    return false;
  }

  /**
   * Should this chunk be meshed now? Gates the remesh worker so we don't spend mesh slots on chunks
   * the render gate will never draw — the occluder shell and the underground bulk behind rock. It's
   * the render set (reachable ∪ face-ring) WITHOUT the mesh-completeness clause of isRenderable (we're
   * deciding whether to build the mesh in the first place). Before the first visibility BFS runs
   * (empty reachable set) it returns true so initial meshing isn't stalled; a skipped chunk stays in
   * the remesh queue and meshes the frame its view opens up (process runs every frame). Meshing is a
   * pure function of a chunk's own + neighbour VOXELS, so deferring it never changes the result —
   * only when it is paid.
   */
  private shouldMeshChunk(cx: number, cy: number, cz: number): boolean {
    const reachable = this.cachedReachable;
    if (!reachable || reachable.size === 0) return true; // pre-BFS: don't block the initial mesh
    if (reachable.has(chunkKey(cx, cy, cz))) return true;
    for (const [dx, dy, dz] of FACE_OFFSETS_6) {
      if (reachable.has(chunkKey(cx + dx, cy + dy, cz + dz))) return true;
    }
    return false;
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

  /** True when running offline (no multiplayer server) — generate chunks locally. */
  private get isLocal(): boolean {
    return !useGameStore.getState().useServerChunks;
  }

  private getLocalPool(): TerrainWorkerPool {
    if (!this.localPool) {
      // Seed + cave settings come from the active local world (multi-world save/load).
      this.localPool = new TerrainWorkerPool(getActiveWorldSeed(), getActiveWorldCaveConfig(), getActiveWorldTerrainConfig());
    }
    return this.localPool;
  }

  /**
   * Local chunk source with persistence: use the saved chunk if this world has
   * one, otherwise generate it off-thread and save it. Every explored chunk is
   * materialized in IndexedDB so the world reloads identically.
   */
  private loadLocalChunk(cx: number, cy: number, cz: number, key: string): void {
    // Coarse LOD levels are cheap to regenerate and their (cx,cy,cz) keys would collide with level-0
    // data in IndexedDB, so they bypass persistence entirely — always generate at the current level.
    if (this.currentLevel > 0) {
      this.getLocalPool().requestChunk(cx, cy, cz, (d) => this.receiveChunkData(d), this.currentLevel);
      return;
    }
    if (hasChunk(key)) {
      loadChunk(key).then((saved) => {
        if (saved) {
          this.receiveChunkData({ chunkX: cx, chunkY: cy, chunkZ: cz, voxelData: saved, lastBuildSeq: 0 });
        } else {
          this.getLocalPool().requestChunk(cx, cy, cz, (d) => { saveChunk(key, d.voxelData); this.receiveChunkData(d); });
        }
      });
    } else {
      this.getLocalPool().requestChunk(cx, cy, cz, (d) => { saveChunk(key, d.voxelData); this.receiveChunkData(d); });
    }
  }

  /**
   * Local surface-column source with persistence. The worker generates the whole
   * column; for each chunk, prefer the saved copy, otherwise save the generated one.
   */
  private async handleLocalColumn(columnData: SurfaceColumnResponse): Promise<void> {
    // Coarse LOD levels aren't persisted — ingest directly.
    if (this.currentLevel > 0) { this.receiveSurfaceColumnData(columnData); return; }
    for (const chunk of columnData.chunks) {
      const key = chunkKey(columnData.tx, chunk.chunkY, columnData.tz);
      if (hasChunk(key)) {
        const saved = await loadChunk(key);
        if (saved) chunk.voxelData = saved;
      } else {
        saveChunk(key, chunk.voxelData);
      }
    }
    this.receiveSurfaceColumnData(columnData);
  }

  /** Rebuild the local world from scratch (e.g. after switching active world). */
  reloadLocalWorld(playerPos?: THREE.Vector3): void {
    // Drop the terrain pool so it recreates with the new active-world seed.
    this.localPool?.dispose();
    this.localPool = null;
    this.clearAndReload(playerPos);
  }

  /**
   * Request a chunk — from the server, or generate it locally (off-thread) in
   * offline mode. The worker callback feeds the same receiveChunkData path.
   */
  private requestChunkFromServer(cx: number, cy: number, cz: number): void {
    const key = chunkKey(cx, cy, cz);
    this.pendingChunks.add(key);
    this.pendingChunkTimes.set(key, Date.now());

    if (this.isLocal) {
      this.loadLocalChunk(cx, cy, cz, key);
      return;
    }

    const request = encodeVoxelChunkRequest({
      chunkX: cx,
      chunkY: cy,
      chunkZ: cz,
      forceRegen: useGameStore.getState().forceRegenerateChunks,
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
    this.pendingTileTimes.set(columnKey, Date.now());

    if (this.isLocal) {
      // Coarse LOD levels bypass persistence (keys collide with level 0; cheap to regenerate).
      if (this.currentLevel > 0) {
        this.getLocalPool().requestTile(tx, tz, (data) => this.receiveTileData(data), this.currentLevel);
        return;
      }
      // Existing world: the column's stamp-corrected heights are persisted, so read them from IDB
      // instead of re-running the full worker generateTile (which re-carves caves just to measure the
      // surface). Falls back to generation if the record is somehow missing.
      if (hasColumn(tx, tz)) {
        loadColumn(tx, tz).then((col) => {
          if (col) this.receiveTileData({ tx, tz, heights: col.heights, materials: col.materials });
          else this.getLocalPool().requestTile(tx, tz, (data) => this.receiveTileData(data));
        }).catch(() => this.getLocalPool().requestTile(tx, tz, (data) => this.receiveTileData(data)));
        return;
      }
      this.getLocalPool().requestTile(tx, tz, (data) => this.receiveTileData(data));
      return;
    }

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
    this.pendingTileTimes.delete(columnKey);
    
    // Compute and store the column's chunk range from the (stamp-corrected) tile heights.
    this.columnInfo.set(columnKey, columnChunkRange(heights, this.currentLevel));

    // Persist the heights the first time a column is generated so a later revisit reads them from IDB
    // instead of regenerating (no-op if they came from loadColumn — already persisted).
    if (this.isLocal && !hasColumn(tx, tz)) saveColumn(tx, tz, heights, materials);

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
  private ingestChunkData(cx: number, cy: number, cz: number, voxelData: Uint32Array, lastBuildSeq: number = 0): Chunk {
    const key = chunkKey(cx, cy, cz);
    
    // Remove from pending
    this.pendingChunks.delete(key);
    this.pendingChunkTimes.delete(key);
    
    // Create or update chunk
    let chunk = this.chunks.get(key);
    const isNewChunk = !chunk;
    if (!chunk) {
      chunk = new Chunk(cx, cy, cz);
      this.chunks.set(key, chunk);
    }

    // Skip re-processing if the voxel data is identical (server re-send or no-op)
    if (!isNewChunk && arraysEqual(chunk.data, voxelData) && chunk.lastBuildSeq === lastBuildSeq) {
      console.warn(`[VoxelWorld] Received identical chunk data for (${cx}, ${cy}, ${cz}), skipping update`);
      return chunk;
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
    this.remeshPipeline.add(key);
    
    // Invalidate BFS cache when new chunks load (they may open visibility paths)
    if (isNewChunk) {
      this.lastBFSChunk = null;
    }

    // Relight and re-queue face-adjacent neighbors so their border light and
    // margin data are up to date. Runs for both new and updated chunks —
    // updated chunks may carry build modifications that change boundary voxels.
    //
    // The relight of a neighbour is skipped when THIS chunk donates no light across the shared face
    // (faceDonatesLight): border injection ignores source voxels with light <= 1, so a fully-dark
    // shared face (the common rock↔rock underground case) cannot change the neighbour's lit state —
    // the skip is output-preserving. This is the dominant saving during column-load bursts, where
    // most internal faces are solid rock. Faces here: +Y (above) is face 2, the horizontals below.
    //
    // The chunk BELOW is exempt: a solid arrival changes its `lightFromAbove` (open-sky → capped)
    // even while donating no border light, so it always relights + remeshes.
    //
    // For the +Y (above) and the 4 horizontal neighbours the relight AND the remesh are now BOTH
    // gated on faceDonatesLight — a neighbour that got no new light needs no remesh either, because
    // its GEOMETRY doesn't depend on this chunk: a chunk meshes its high-side border from its OWN
    // +X/+Y/+Z margin sources, so its −direction neighbour (this chunk) is never a mesh input. The
    // margin-consumers that DO read this chunk (its −X/−Y/−Z faces/edges/corner) are remeshed
    // unconditionally by the NEGATIVE_MARGIN_OFFSETS_7 loop below. Result: a fully-dark underground
    // arrival fans out to just its below relight + the margin loop, instead of re-meshing all 6
    // faces every time — the dominant remesh churn during a column-load burst.
    const belowKey = chunkKey(cx, cy - 1, cz);
    const belowChunk = this.chunks.get(belowKey);
    if (belowChunk) {
      this.computeChunkSunlight(cx, cy - 1, cz, belowChunk.data);
      belowChunk.dirty = true;
      this.remeshPipeline.add(belowKey);
    }

    const aboveKey = chunkKey(cx, cy + 1, cz);
    const aboveChunk = this.chunks.get(aboveKey);
    if (aboveChunk && faceDonatesLight(chunk.data, 2 /* +Y */)) {
      this.computeChunkSunlight(cx, cy + 1, cz, aboveChunk.data);
      aboveChunk.dirty = true;
      this.remeshPipeline.add(aboveKey);
    }

    for (const [dx, dy, dz] of FACE_OFFSETS_6) {
      if (dy !== 0) continue; // vertical already handled above
      const nKey = chunkKey(cx + dx, cy + dy, cz + dz);
      const nChunk = this.chunks.get(nKey);
      if (!nChunk) continue;
      // dx/dz map to FACE_OFFSETS_6 indices: +X=0,-X=1,+Z=4,-Z=5.
      const face = dx === 1 ? 0 : dx === -1 ? 1 : dz === 1 ? 4 : 5;
      if (faceDonatesLight(chunk.data, face)) {
        this.computeChunkSunlight(nChunk.cx, nChunk.cy, nChunk.cz, nChunk.data);
        nChunk.dirty = true;
        this.remeshPipeline.add(nKey);
      }
    }

    // Re-mesh every chunk that consumes THIS chunk as a margin source (its 7 negative-direction
    // neighbours: faces, edges, corner). The loops above refresh light + the 6 faces; this closes the
    // edge/corner case — a diagonal neighbour that meshed before this chunk arrived was reading an
    // extrapolated margin, so its shared corner/edge verts are misaligned until it re-meshes with
    // this chunk present. Deduped by the remesh queue (Set). Applies to every ingest path.
    for (const [dx, dy, dz] of NEGATIVE_MARGIN_OFFSETS_7) {
      const nKey = chunkKey(cx + dx, cy + dy, cz + dz);
      if (this.chunks.has(nKey)) this.remeshPipeline.add(nKey);
    }

    // Execute any build operations that were waiting for this chunk
    this.drainDeferredBuildOps();

    // Notify the minimap so it can capture this chunk's stamps (trees/rocks/etc.).
    this.onChunkIngested?.(key);

    return chunk;
  }

  /**
   * Compute sunlight columns for a chunk in-place.
   * Checks chunk-above data to determine sky exposure.
   * Then injects border light from face-adjacent neighbors and runs BFS.
   */
  private computeChunkSunlight(cx: number, cy: number, cz: number, data: Uint32Array): void {
    perfStats.begin('lighting');
    const lightFromAbove = this.sunlightFromAbove(cx, cy, cz);
    const neighbors = this.gatherFaceNeighbors(cx, cy, cz);
    // Combined pipeline: sky (column + BFS) then block (emitter BFS). Returns whether
    // the chunk holds any block light, cached on the Chunk to gate future relights.
    const hasBlock = computeAndPropagateLight(data, lightFromAbove, neighbors);
    const chunk = this.chunks.get(chunkKey(cx, cy, cz));
    if (chunk) chunk.hasBlockLight = hasBlock;
    perfStats.end('lighting');
  }

  /** Gather the 6 face-adjacent neighbor voxel arrays (+X,-X,+Y,-Y,+Z,-Z), null if unloaded. */
  private gatherFaceNeighbors(cx: number, cy: number, cz: number): (Uint32Array | null)[] {
    return FACE_OFFSETS_6.map(
      ([dx, dy, dz]) => this.chunks.get(chunkKey(cx + dx, cy + dy, cz + dz))?.data ?? null,
    );
  }

  /**
   * Per-column light entering the top of a chunk. Uses the loaded chunk above if present; otherwise
   * assumes open sky UNLESS the chunk is fully underground — i.e. below the column's LOWEST surface
   * point (cy < minCy), where there's no open sky anywhere in the footprint. Those default to DARK,
   * so an underground cave isn't lit as open sky when the (solid) chunk above it hasn't loaded (and,
   * since the BFS can't traverse solid rock, may never load). Surface chunks — slopes, flush tops,
   * and columns at the BFS edge whose air chunk above isn't loaded — are at cy >= minCy and stay lit.
   * When a missing chunk above does load, ingest relights this chunk correctly.
   */
  private sunlightFromAbove(cx: number, cy: number, cz: number): Uint8Array | null {
    const fromAbove = getSunlitAbove(this.chunks.get(chunkKey(cx, cy + 1, cz))?.data);
    if (fromAbove) return fromAbove; // chunk above loaded → real propagated light
    const info = this.columnInfo.get(`${cx},${cz}`);
    return info && cy < info.minCy ? DARK_ABOVE : null; // fully underground → dark, else open sky
  }

  /** Temp-aware accessor for preview relight: preview (temp) data where present, else committed. */
  private readonly tempGetData = (cx: number, cy: number, cz: number): Uint32Array | null => {
    const c = this.chunks.get(chunkKey(cx, cy, cz));
    return c ? (c.tempData ?? c.data) : null;
  };

  /**
   * Whether preview block relight is warranted: an emitter in a drawn chunk, or existing block
   * light anywhere in the drawn chunks' 3×3×3 region.
   */
  private previewRunBlock(drawn: Chunk[]): boolean {
    if (drawn.some((c) => chunkHasEmitter(c.tempData!) || c.hasBlockLight)) return true;
    for (const c of drawn) {
      for (let dz = -1; dz <= 1; dz++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (this.chunks.get(chunkKey(c.cx + dx, c.cy + dy, c.cz + dz))?.hasBlockLight) return true;
          }
    }
    return false;
  }

  /**
   * Relight the chunks that will be RE-MESHED this preview, synchronously on their temp buffers
   * (cheap — a handful of chunks), through the shared relightRegion() so preview and commit don't
   * drift. This is the drawn chunks PLUS their margin-consumer neighbours (whose +margin geometry
   * changed and so are re-meshed by Pass 2b) — every re-meshed chunk must carry preview light or its
   * new mesh shows stale/dark light at the edit (the dark-border bug). Runs before meshing so the
   * mesh shows correct light immediately, waiting on nothing. Light spilling into chunks that are NOT
   * re-meshed is handled separately by relightPreviewSpill(). Each passed chunk needs a temp buffer.
   */
  relightPreviewMeshSet(meshKeys: string[]): void {
    const drawn = meshKeys
      .map((k) => this.chunks.get(k))
      .filter((c): c is Chunk => !!c && !!c.tempData);
    if (drawn.length === 0) return;

    const runBlock = this.previewRunBlock(drawn);
    const map = new Map<string, RelightTarget>();
    for (const c of drawn) {
      map.set(c.key, { cx: c.cx, cy: c.cy, cz: c.cz, sky: true, block: runBlock });
    }

    perfStats.begin('lighting');
    relightRegion(this.tempGetData, this.finalizeTargets(map));
    perfStats.end('lighting');
  }

  /**
   * Relight the SPILL neighbours — chunks changed by LIGHT but not by the draw (the 6 face
   * neighbours for sky border bleed, plus the loaded 3×3×3 for block when a torch/emitter is
   * involved) — synchronously, reading the already-relit drawn chunks. The relight itself is cheap;
   * each neighbour's display is refreshed with a light-only resample + a ranged write into its
   * group's merged buffer (no re-mesh, no group re-merge — see ChunkGrouper.updateChunkLight).
   *
   * `excludeKeys` are chunks already being re-meshed this preview (the drawn chunks and their
   * margin-consumer neighbours from Pass 2b). Those are skipped: their geometry — and therefore the
   * margin a light-only resample would read — changed, so resampling stale geometry would leave dark
   * seams; the re-mesh gives them correct light instead.
   *
   * @returns the spill neighbour keys whose display was overridden (caller restores them on exit).
   */
  relightPreviewSpill(drawnKeys: string[], excludeKeys: Set<string>): string[] {
    const drawn = drawnKeys
      .map((k) => this.chunks.get(k))
      .filter((c): c is Chunk => !!c && !!c.tempData);
    if (drawn.length === 0) return [];

    const map = this.collectSpillTargets(drawn, excludeKeys, this.previewRunBlock(drawn));
    if (map.size === 0) return [];

    // Temp copy each spill chunk (non-destructive) before relighting reads/writes it.
    for (const t of map.values()) {
      const n = this.chunks.get(chunkKey(t.cx, t.cy, t.cz));
      if (n && !n.tempData) n.copyToTemp();
    }
    const spillTargets = this.finalizeTargets(map);

    perfStats.begin('lighting');
    relightRegion(this.tempGetData, spillTargets);

    // Light-only refresh of each spill neighbour's display (resample + merged-buffer slice write).
    const spillKeys: string[] = [];
    for (const t of spillTargets) {
      const key = chunkKey(t.cx, t.cy, t.cz);
      if (this.resamplePreviewChunkLight(key, true)) spillKeys.push(key);
    }
    perfStats.end('lighting');

    return spillKeys;
  }

  /**
   * The spill target map for a preview around `drawn`: the 6 sky-face neighbours of each drawn chunk,
   * plus the 3×3×3 block region when a torch/emitter is involved (`runBlock`). Loaded chunks only,
   * excluding `excludeKeys` (the re-meshed set — those get correct light from their re-mesh instead).
   * Shared by relightPreviewSpill (which relights the map) and collectSpillKeys (keys only) so the
   * two can't drift on which neighbours count as spill.
   */
  private collectSpillTargets(
    drawn: Chunk[],
    excludeKeys: Set<string>,
    runBlock: boolean,
  ): Map<string, RelightTarget> {
    const map = new Map<string, RelightTarget>();
    const ensure = (cx: number, cy: number, cz: number): RelightTarget | null => {
      const k = chunkKey(cx, cy, cz);
      if (excludeKeys.has(k) || !this.chunks.has(k)) return null;
      let t = map.get(k);
      if (!t) { t = { cx, cy, cz, sky: false, block: false }; map.set(k, t); }
      return t;
    };
    for (const c of drawn) {
      for (const [dx, dy, dz] of FACE_OFFSETS_6) {
        const t = ensure(c.cx + dx, c.cy + dy, c.cz + dz);
        if (t) t.sky = true;
      }
      if (runBlock) {
        for (let dz = -1; dz <= 1; dz++)
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const t = ensure(c.cx + dx, c.cy + dy, c.cz + dz);
              if (t) t.block = true;
            }
      }
    }
    return map;
  }

  /**
   * The spill neighbour keys for a preview at `drawnKeys` (loaded, minus `excludeKeys`) — keys only,
   * no relight or temp copy. Lets BuildPreview reconcile which spill overrides to drop as the cursor
   * moves (restoring far neighbours that are no longer adjacent) cheaply, every frame, while the
   * spill RELIGHT itself stays deferred to settle.
   */
  collectSpillKeys(drawnKeys: string[], excludeKeys: Set<string>): Set<string> {
    const drawn = drawnKeys
      .map((k) => this.chunks.get(k))
      .filter((c): c is Chunk => !!c && !!c.tempData);
    if (drawn.length === 0) return new Set();
    return new Set(this.collectSpillTargets(drawn, excludeKeys, this.previewRunBlock(drawn)).keys());
  }

  /**
   * Finalize a relight target map: seed each sky target that has no loaded chunk above with the
   * column's light-from-above, then return the targets sorted top-down (cy descending) so the shared
   * relight sees each chunk's freshly-relit neighbour above. Shared by commit + both preview passes.
   */
  private finalizeTargets(map: Map<string, RelightTarget>): RelightTarget[] {
    for (const t of map.values()) {
      if (t.sky && !this.chunks.has(chunkKey(t.cx, t.cy + 1, t.cz))) {
        t.skyAbove = this.sunlightFromAbove(t.cx, t.cy, t.cz);
      }
    }
    return [...map.values()].sort((a, b) => b.cy - a.cy);
  }

  /**
   * Light-only resample of a chunk's existing geometry from its temp (preview) or committed data,
   * used to show/restore preview spill light without re-meshing. Marks the owning merged group
   * dirty so it re-copies the new light. No-op (returns false) if the chunk has no geometry yet.
   */
  private resamplePreviewChunkLight(key: string, useTemp: boolean): boolean {
    const chunk = this.chunks.get(key);
    const geo = this.geometries.get(key);
    if (!chunk || !geo || !geo.hasGeometry()) return false;
    const grid = this.meshPool.takeGrid();
    expandChunkToGrid(chunk, this.chunks, grid, useTemp);
    const changed = geo.resampleLightFromGrid(grid);
    this.meshPool.returnGrid(grid);
    // Push the two rewritten light attributes into the group's merged buffer as a ranged write —
    // no full group re-merge (that churn was the preview slowdown).
    if (changed) this.chunkGrouper.updateChunkLight(key);
    return true;
  }

  /**
   * Restore a spill neighbour's displayed light after it leaves preview: drop its temp buffer and
   * light-only resample its geometry back from committed data. Cheap (no re-mesh); committed data
   * was never mutated, so this fully reverts the preview override.
   */
  restorePreviewChunkLight(key: string): void {
    const chunk = this.chunks.get(key);
    if (chunk) chunk.discardTemp();
    this.resamplePreviewChunkLight(key, false);
  }

  /**
   * Revert a chunk's committed-geometry light override back to committed data WITHOUT discarding its
   * temp buffer. Used when a spill neighbour (whose committed display was overridden by an earlier
   * spill relight) becomes a re-meshed preview chunk: its committed override must be undone so it can't
   * leak past the preview, but its temp must survive for the pending re-mesh. The owning group is
   * marked dirty so a later restore re-merges the corrected light instead of showing the stale override
   * still sitting in the merged buffer (which restoreGroup's clean-merge fast path would otherwise keep).
   */
  revertPreviewChunkDisplayLight(key: string): void {
    this.resamplePreviewChunkLight(key, false);
    this.chunkGrouper.markChunkDirty(key);
  }

  /**
   * Light-only resample of a build-preview mesh (owned by BuildPreview, not a ChunkGeometry) from
   * the chunk's relit temp grid. Rewrites just the mesh's two light attributes — no re-mesh. Called
   * in the deferred lighting phase, AFTER the whole region (incl. this chunk's neighbours) is relit,
   * so boundary vertices sample their neighbours' updated light (fixes the dark border at edits).
   */
  resamplePreviewMeshLight(
    key: string,
    meshes: (THREE.Mesh | null)[],
    cellIndices: (Uint16Array | null)[],
  ): void {
    const chunk = this.chunks.get(key);
    if (!chunk || !chunk.tempData) return;
    const grid = this.meshPool.takeGrid();
    expandChunkToGrid(chunk, this.chunks, grid, true);
    for (let layer = 0; layer < meshes.length; layer++) {
      const mesh = meshes[layer];
      const cells = cellIndices[layer];
      if (mesh && cells) resampleLightAttributes(mesh.geometry, cells, grid);
    }
    this.meshPool.returnGrid(grid);
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
    this.pendingColumnTimes.delete(columnKey);
    
    // Store the column's chunk range from the (stamp-corrected) tile heights.
    this.columnInfo.set(columnKey, columnChunkRange(heights, this.currentLevel));

    // Persist heights on first generation so a revisit skips regeneration (Change 3).
    if (this.isLocal && !hasColumn(tx, tz)) saveColumn(tx, tz, heights, materials);

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
   * Handle a REQUEST_NACK from the server.
   * Clears the matching pending entry so it can be re-requested next BFS cycle.
   */
  handleRequestNack(nack: RequestNack): void {
    const { originalMsgId, x, y, z } = nack;

    switch (originalMsgId) {
      case MSG_VOXEL_CHUNK_REQUEST: {
        const key = chunkKey(x, y, z);
        console.warn(`[VoxelWorld] NACK: chunk request (${x},${y},${z}) rejected, will retry`);
        this.pendingChunks.delete(key);
        this.pendingChunkTimes.delete(key);
        break;
      }
      case MSG_MAP_TILE_REQUEST: {
        const columnKey = `${x},${z}`;
        console.warn(`[VoxelWorld] NACK: tile request (${x},${z}) rejected, will retry`);
        this.pendingTiles.delete(columnKey);
        this.pendingTileTimes.delete(columnKey);
        break;
      }
      case MSG_SURFACE_COLUMN_REQUEST: {
        const columnKey = `${x},${z}`;
        console.warn(`[VoxelWorld] NACK: surface column request (${x},${z}) rejected, will retry`);
        this.pendingColumns.delete(columnKey);
        this.pendingColumnTimes.delete(columnKey);
        // Allow initial column re-request if it was the one that got NACKed
        if (this.pendingColumns.size === 0 && this.columnInfo.size === 0) {
          this.initialColumnRequested = false;
        }
        break;
      }
    }

    // Invalidate BFS so freed slot gets re-requested
    this.lastBFSChunk = null;
  }

  /**
   * Unload a chunk by key.
   */
  private unloadChunk(key: string): void {
    // Notify listeners before cleanup
    for (const listener of this.unloadListeners) listener(key);

    // Geometry map is changing — need a visibility rescan
    this.visibilityDirty = true;

    // Remove from grouper before disposing geometry
    this.chunkGrouper.removeChunk(key);

    // Dispose geometry
    const geo = this.geometries.get(key);
    if (geo) {
      geo.dispose();
      this.geometries.delete(key);
      this.meshCountDirty = true;
    }

    // Remove from remesh queue (mesh-completeness lives on the chunk's `phase`, which is deleted below —
    // no separate forget-on-unload contract to maintain).
    this.remeshPipeline.delete(key);

    // Remove from pending if it was still pending
    this.pendingChunks.delete(key);
    this.pendingChunkTimes.delete(key);

    // Remove chunk (its ChunkPhase goes with it)
    this.chunks.delete(key);
  }

  /**
   * Re-mesh every chunk that reads chunk (cx,cy,cz) as a margin source — its 7 negative-direction
   * neighbours (faces, edges, corner). A mesh's high-side margin is filled from its +X/+Y/+Z faces,
   * edges, and corner (see expandChunkData), so those exact 7 neighbours must re-mesh when this
   * chunk's voxels change/arrive, or a diagonal neighbour keeps an extrapolated margin → misaligned
   * corner/edge boundary verts (a seam gap). Public so the build system can trigger it after commits.
   */
  queueNeighborRemesh(cx: number, cy: number, cz: number): void {
    for (const [dx, dy, dz] of NEGATIVE_MARGIN_OFFSETS_7) {
      const key = chunkKey(cx + dx, cy + dy, cz + dz);
      if (this.chunks.has(key)) {
        this.remeshPipeline.add(key);
      }
    }
  }

  /**
   * Remesh a single chunk synchronously.
   * Delegates to RemeshPipeline.
   */
  remeshChunk(chunk: Chunk): void {
    this.remeshPipeline.remeshSync(chunk);
  }

  /**
   * Remesh all dirty chunks synchronously.
   * Delegates to RemeshPipeline.
   */
  remeshAllDirty(): void {
    this.remeshPipeline.remeshAllDirty();
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
    if (!this.meshCountDirty) return this.cachedMeshCount;
    let count = 0;
    for (const geo of this.geometries.values()) {
      if (geo.hasGeometry()) {
        count++;
      }
    }
    this.cachedMeshCount = count;
    this.meshCountDirty = false;
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
      remeshQueueSize: this.remeshPipeline.size,
    };
  }

  /**
   * Force reload and remesh all chunks.
   */
  refresh(): void {
    // Queue all chunks for remesh
    for (const key of this.chunks.keys()) {
      this.remeshPipeline.add(key);
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

    // Before-images (local only) so the op can be undone.
    const undoSnapshots: ChunkSnapshot[] = [];

    const editedChunks: Chunk[] = [];
    for (const key of affectedKeys) {
      const chunk = this.chunks.get(key)!;

      // Snapshot the pre-mutation voxels for undo.
      const before = this.isLocal ? new Uint32Array(chunk.data) : null;

      const changed = drawToChunk(chunk, operation);
      if (changed) {
        modifiedKeys.push(key);
        editedChunks.push(chunk);
        if (before) undoSnapshots.push({ key, data: before });
      }
    }

    // Invalidate BFS cache so visibility recomputes with updated chunk data.
    // Carving can expose previously-hidden chunks that need to be loaded.
    if (modifiedKeys.length > 0) {
      this.lastBFSChunk = null;
    }

    // Relight the whole affected region in one shared pass, then re-mesh the chunks whose
    // geometry changed and light-only-resample the rest.
    const batchKeys = this.relightEditedChunks(editedChunks);
    this.dispatchRelightBatch(batchKeys, modifiedKeys);

    // Persist edited chunks + record undo for the active local world.
    if (this.isLocal) {
      for (const key of modifiedKeys) {
        const chunk = this.chunks.get(key);
        if (chunk) saveChunk(key, chunk.data);
      }
      if (undoSnapshots.length > 0) pushUndo(undoSnapshots);
    }

    return modifiedKeys;
  }

  /** Live-data accessor for relightRegion — reads committed chunk voxel arrays. */
  private readonly liveGetData = (cx: number, cy: number, cz: number): Uint32Array | null =>
    this.chunks.get(chunkKey(cx, cy, cz))?.data ?? null;

  /**
   * Collect the relight target set for an edit to `editedChunks` (loaded chunks only), matching the
   * previous per-chunk cascade but as one region:
   *  - SKY: each edited chunk + its loaded column below + the chunk above + the 4 horizontal faces.
   *  - BLOCK: the loaded 3×3×3 around each edited chunk — but only when warranted (an edited chunk
   *    emits, or some region chunk already holds block light), so ordinary edits stay cheap.
   * Sky targets are returned sorted top-down (cy descending) so the shared relight sees each chunk's
   * freshly-relit neighbour above. Edge chunks whose chunk-above isn't loaded carry a skyAbove seed.
   */
  private collectRelightTargets(editedChunks: Chunk[]): RelightTarget[] {
    const map = new Map<string, RelightTarget>();
    const ensure = (cx: number, cy: number, cz: number): RelightTarget => {
      const k = chunkKey(cx, cy, cz);
      let t = map.get(k);
      if (!t) { t = { cx, cy, cz, sky: false, block: false }; map.set(k, t); }
      return t;
    };

    // Block gate: emitter in an edited chunk, or existing block light anywhere in a 3×3×3.
    let runBlock = editedChunks.some((e) => chunkHasEmitter(e.data));
    if (!runBlock) {
      for (const e of editedChunks) {
        for (let dz = -1; dz <= 1 && !runBlock; dz++)
          for (let dy = -1; dy <= 1 && !runBlock; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              if (this.chunks.get(chunkKey(e.cx + dx, e.cy + dy, e.cz + dz))?.hasBlockLight) {
                runBlock = true;
                break;
              }
            }
        if (runBlock) break;
      }
    }

    for (const e of editedChunks) {
      ensure(e.cx, e.cy, e.cz).sky = true;
      // Cascade sky down the loaded column and up one.
      for (let by = e.cy - 1; this.chunks.has(chunkKey(e.cx, by, e.cz)); by--) {
        ensure(e.cx, by, e.cz).sky = true;
      }
      if (this.chunks.has(chunkKey(e.cx, e.cy + 1, e.cz))) ensure(e.cx, e.cy + 1, e.cz).sky = true;
      // Horizontal face neighbours (border sky light).
      for (const [dx, dy, dz] of FACE_OFFSETS_6) {
        if (dy !== 0) continue;
        if (this.chunks.has(chunkKey(e.cx + dx, e.cy + dy, e.cz + dz))) {
          ensure(e.cx + dx, e.cy + dy, e.cz + dz).sky = true;
        }
      }
      // Block region (loaded 3×3×3), when warranted.
      if (runBlock) {
        for (let dz = -1; dz <= 1; dz++)
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              if (this.chunks.has(chunkKey(e.cx + dx, e.cy + dy, e.cz + dz))) {
                ensure(e.cx + dx, e.cy + dy, e.cz + dz).block = true;
              }
            }
      }
    }

    // Seed light-from-above for region-edge sky targets + sort top-down (shared with preview).
    return this.finalizeTargets(map);
  }

  /**
   * Relight the region affected by edits to `editedChunks` (shared by build commit + undo). Runs the
   * single shared region orchestration over live data, updates cached block-light flags + dirty
   * marks, recomputes visibility for the edited chunks, and returns every relit chunk key.
   */
  private relightEditedChunks(editedChunks: Chunk[]): Set<string> {
    const batchKeys = new Set<string>();
    if (editedChunks.length === 0) return batchKeys;

    const targets = this.collectRelightTargets(editedChunks);

    perfStats.begin('lighting');
    relightRegion(this.liveGetData, targets);
    perfStats.end('lighting');

    for (const t of targets) {
      const key = chunkKey(t.cx, t.cy, t.cz);
      const chunk = this.chunks.get(key);
      if (!chunk) continue;
      if (t.block) chunk.hasBlockLight = chunkHasBlockLight(chunk.data);
      chunk.dirty = true;
      batchKeys.add(key);
    }
    // Visibility only depends on voxels, so recompute it just for the edited chunks.
    for (const e of editedChunks) e.visibilityBits = computeVisibility(e.data);

    return batchKeys;
  }

  /**
   * Apply a relight result to the display: chunks whose voxels changed (`editedKeys`) plus any
   * relit chunk that reads an edited chunk's voxels as +margin (its boundary geometry changed) get
   * a full re-mesh; every other relit chunk only changed light and takes the light-only resample
   * path — no SurfaceNets, no geometry realloc, no collision BVH rebuild (kills the edit judder).
   *
   * @param batchKeys  All chunks whose light was recomputed this edit.
   * @param editedKeys Subset of chunks whose VOXELS changed.
   */
  private dispatchRelightBatch(batchKeys: Set<string>, editedKeys: string[]): void {
    // Start with the edited chunks, then add any relit chunk that consumes an edited chunk's
    // voxels as margin (restricted to chunks already in the relight set — we don't widen it here).
    const remeshKeys = new Set<string>(editedKeys);
    for (const ek of editedKeys) {
      const c = this.chunks.get(ek);
      if (!c) continue;
      for (const [dx, dy, dz] of NEGATIVE_MARGIN_OFFSETS_7) {
        const nk = chunkKey(c.cx + dx, c.cy + dy, c.cz + dz);
        if (batchKeys.has(nk)) remeshKeys.add(nk);
      }
    }

    // Light-only resample everyone else; fall back to a full re-mesh if resampling isn't possible
    // (chunk not yet meshed, or a full re-mesh is already in flight and will produce fresh light).
    for (const key of batchKeys) {
      if (remeshKeys.has(key)) continue;
      const chunk = this.chunks.get(key);
      if (!chunk || !this.resampleChunkLight(chunk)) remeshKeys.add(key);
    }

    // Edited/boundary chunks re-mesh as one atomic batch (same-frame swap, no boundary flash).
    this.remeshPipeline.dispatchBatch(remeshKeys);
  }

  /**
   * Light-only relight of a single chunk: rebuild its 34³ grid (reading the already-updated light
   * bits from chunk.data + neighbours) and rewrite ONLY the mesh's light attributes — no re-mesh,
   * no BVH rebuild. Marks the owning merged group dirty so it re-copies the new light next frame.
   *
   * @returns true if handled by resampling; false if the caller must fall back to a full re-mesh
   *   (no geometry yet, or a re-mesh is already in flight for this chunk).
   */
  private resampleChunkLight(chunk: Chunk): boolean {
    if (this.remeshPipeline.isBusy(chunk.key)) return false; // let the in-flight re-mesh own the light
    const geo = this.geometries.get(chunk.key);
    if (!geo || !geo.hasGeometry()) return false;

    const grid = this.meshPool.takeGrid();
    expandChunkToGrid(chunk, this.chunks, grid);
    const changed = geo.resampleLightFromGrid(grid);
    this.meshPool.returnGrid(grid);

    // Ranged write into the merged buffer instead of a full group re-merge (cuts edit judder).
    if (changed) this.chunkGrouper.updateChunkLight(chunk.key);
    return true;
  }

  /**
   * Undo the most recent local build op (restores chunks + persists the revert).
   * @returns the reverted chunk keys (for map-tile refresh), or [] if nothing to undo.
   */
  undoLastBuild(): string[] {
    if (!this.isLocal) return [];
    const entry = popUndo();
    if (!entry) return [];

    const editedChunks: Chunk[] = [];
    for (const snap of entry) {
      const chunk = this.chunks.get(snap.key);
      if (chunk) {
        chunk.data.set(snap.data);
        editedChunks.push(chunk);
        saveChunk(snap.key, chunk.data);
      } else {
        // Chunk not loaded — revert the persisted copy so it reloads undone.
        saveChunk(snap.key, snap.data);
      }
    }
    if (editedChunks.length > 0) {
      this.lastBFSChunk = null;
      const batchKeys = this.relightEditedChunks(editedChunks);
      this.dispatchRelightBatch(batchKeys, editedChunks.map((c) => c.key));
    }
    return entry.map((s) => s.key);
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
      this.localPool?.dispose();
      this.localPool = null;
    }

    // Dispose chunk grouper (removes merged meshes from scene)
    this.chunkGrouper.dispose();

    // Dispose all chunk geometry holders
    for (const geo of this.geometries.values()) {
      geo.dispose();
    }
    this.geometries.clear();

    // Clear chunks
    this.chunks.clear();

    // Clear pending
    this.pendingChunks.clear();
    this.pendingColumns.clear();
    this.pendingTiles.clear();
    this.pendingChunkTimes.clear();
    this.pendingColumnTimes.clear();
    this.pendingTileTimes.clear();

    // Clear column info
    this.columnInfo.clear();

    // Clear remesh queue
    this.remeshPipeline.clear();

    // Clear deferred build operations
    this.deferredBuildOps.length = 0;

    // Clear preview chunk tracking
    this.previewChunks.clear();

    // Reset streaming state so the next update re-seeds the world from scratch
    // (initial surface column + BFS). Without this a clear+reload — e.g. switching
    // worlds — never re-requests the seeding column and nothing streams.
    this.lastPlayerChunk = null;
    this.lastBFSChunk = null;
    this.initialColumnRequested = false;

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
