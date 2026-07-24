/**
 * CoarseRingStreamer — Explore's concentric coarse-LOD rings (Phase B, commit 2b).
 *
 * The base (finest) LOD level is streamed by VoxelWorld with the full occlusion-BFS + retire-and-swap
 * machinery, over its own disk. This module renders the COARSER rings BEYOND that disk: for each coarse
 * level L > base within view, it streams a thin ANNULUS of surface columns at that level and shows them
 * always (no occlusion — a distant backdrop). Together they form per-distance LOD: fine in the centre,
 * progressively coarser outward (docs/lod-phase-b-concentric-rings.md §2).
 *
 * Design choices that keep this a low-blast-radius, additive change:
 *  - Fully ISOLATED from the base/play streaming path. Each coarse level owns its OWN chunk/geometry
 *    maps, remesh pipeline, and grouper (a `CoarseLevelRig`). Nothing shares the base level's bare-keyed
 *    structures, so the level-0 coordinate range can overlap a coarse level's without collision. The base
 *    level and play mode are untouched.
 *  - The mesh-worker POOL is shared with the base pipeline. That's safe: the pool routes results by a
 *    unique per-dispatch id (not by chunk key) and the callback is closure-bound to the right rig's maps,
 *    so a same-bare-key clash between a base and a coarse chunk only serialises their dispatch (one waits a
 *    frame), never misroutes a result.
 *  - Rings are a SURFACE SHELL: a simple annulus enumeration streams each column's surface band and shows
 *    everything (no visibility BFS, no build/preview, no relight-on-edit). Cross-level seams at ring
 *    boundaries crack — accepted for now (skirts are the next Phase B step).
 *  - LOCAL worlds only. Server-hosted Explore keeps just the base level (no rings) — coarse generation
 *    goes through the local terrain pool + level-namespaced IndexedDB, same keys VoxelWorld persists under.
 *
 * "Wave of refinement from centre out": a coarse level only begins streaming once the next-finer resident
 * ring has gone quiet, so refinement propagates outward one ring at a time.
 */

import * as THREE from 'three';
import {
  CHUNK_SIZE,
  CHUNK_WORLD_SIZE,
  MAX_ZOOM_LEVEL,
  FACE_OFFSETS_6,
  chunkKey,
  getChunkRangeFromHeights,
  getSunlitAbove,
  computeAndPropagateLight,
  type VoxelChunkData,
  type MapTileResponse,
} from '@worldify/shared';
import { Chunk } from './Chunk.js';
import { ChunkGeometry } from './ChunkGeometry.js';
import { ChunkGrouper } from './ChunkGrouper.js';
import { RemeshPipeline } from './RemeshPipeline.js';
import { MeshWorkerPool } from './MeshWorkerPool.js';
import { setEmptyAirPredicate } from './ChunkMesher.js';
import { TerrainWorkerPool } from './TerrainWorkerPool.js';
import { ringOuterRadius } from './ringLevel.js';
import { hasChunk, loadChunk, saveChunk, hasColumn, loadColumn, saveColumn } from '../world/WorldManager.js';

/** How many coarse rings to keep resident beyond the base disk. Bounds memory/streaming (docs §5c). */
const NUM_COARSE_RINGS = 3;

/** Extra chunks kept loaded beyond a ring's annulus before unloading (hysteresis, avoids edge thrash). */
const RING_UNLOAD_HYSTERESIS = 1;

/** Cap on in-flight chunk requests per coarse level (keeps a coarse ring from starving base). */
const MAX_PENDING_PER_LEVEL = 16;

const DARK_ABOVE = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);

/** True-world (metres) size of one level-L chunk. */
function levelChunkWorld(level: number): number {
  return CHUNK_WORLD_SIZE * (1 << level);
}

/** Chunk-Y band for a coarse column from its (stamp-corrected) heights (mirrors VoxelWorld.columnChunkRange). */
function columnBand(heights: ArrayLike<number>, level: number): { minCy: number; maxCy: number } {
  const span = CHUNK_SIZE << level;
  const { minHeight, maxHeight } = getChunkRangeFromHeights(heights);
  return { minCy: Math.floor(minHeight / span), maxCy: Math.floor((maxHeight + 1) / span) };
}

/** Everything one coarse LOD level needs to stream + render its ring, isolated from every other level. */
interface CoarseLevelRig {
  level: number;
  chunks: Map<string, Chunk>;
  geometries: Map<string, ChunkGeometry>;
  columnInfo: Map<string, { minCy: number; maxCy: number }>;
  pendingChunks: Set<string>;
  pendingColumns: Set<string>;   // tiles (surface band extents) in flight
  grouper: ChunkGrouper;
  remesh: RemeshPipeline;
  /** Bumped when this rig is torn down, so a late async generation result for the old incarnation drops. */
  epoch: number;
  /** True once this ring has streamed everything in its annulus and no mesh work remains (wave gate). */
  quiet: boolean;
  /** Previous frame's `quiet`, so the settle diagnostic logs once per false→true transition. */
  wasQuiet: boolean;
}

export class CoarseRingStreamer {
  private rigs = new Map<number, CoarseLevelRig>();
  private readonly scene: THREE.Scene;
  private readonly meshPool: MeshWorkerPool;
  private readonly getLocalPool: () => TerrainWorkerPool;
  private readonly isLocal: () => boolean;
  private _center = new THREE.Vector3();
  private _localCenter = new THREE.Vector3();
  /** Live base-level visibility radius (quality-dependent) — drives the ring radii so ring 1 abuts the
   *  base disk regardless of quality. Set each frame by update(). */
  private _visibilityRadius = 11;

  constructor(
    scene: THREE.Scene,
    meshPool: MeshWorkerPool,
    getLocalPool: () => TerrainWorkerPool,
    isLocal: () => boolean,
  ) {
    this.scene = scene;
    this.meshPool = meshPool;
    this.getLocalPool = getLocalPool;
    this.isLocal = isLocal;
  }

  /** Level-namespaced IndexedDB key — must match VoxelWorld.persistKey so coarse levels share cached gen. */
  private persistKey(base: string, level: number): string {
    return level === 0 ? base : `${level}:${base}`;
  }

  /**
   * Stream + render the coarse rings for the current base level around `centerWorld` (TRUE-world metres).
   * Rings resident: base+1 .. min(MAX_ZOOM_LEVEL, base+NUM_COARSE_RINGS). Levels outside that (e.g. after a
   * zoom) are disposed. No-op when not local (server Explore has no rings).
   */
  update(baseLevel: number, centerWorld: THREE.Vector3, visibilityRadius: number): void {
    if (!this.isLocal()) { this.clear(); return; }
    this._center.copy(centerWorld);
    this._visibilityRadius = visibilityRadius;

    const maxLevel = Math.min(MAX_ZOOM_LEVEL, baseLevel + NUM_COARSE_RINGS);

    // Drop rings no longer in the resident band (finer than base+1, or beyond maxLevel).
    for (const [lvl, rig] of [...this.rigs]) {
      if (lvl <= baseLevel || lvl > maxLevel) this.disposeRig(rig);
    }

    // Stream finest→coarsest. The wave gate defers only CREATING a brand-new deeper ring until the
    // next-finer resident ring has gone quiet (refinement from centre out). Rings that ALREADY exist are
    // always re-streamed, so after a zoom (which changes every ring's radii) they reposition to the new
    // base's annuli instead of freezing at stale radii. The innermost coarse ring (base+1) has no coarse
    // inner neighbour — the base level is its always-present foreground, streamed independently by
    // VoxelWorld — so it starts immediately.
    for (let level = baseLevel + 1; level <= maxLevel; level++) {
      if (!this.rigs.has(level)) {
        const inner = this.rigs.get(level - 1);
        if (inner && !inner.quiet) break;   // hold a NEW deeper ring until its inner neighbour settles
      }
      this.streamRing(this.rigForLevel(level), baseLevel);
    }
  }

  private rigForLevel(level: number): CoarseLevelRig {
    let rig = this.rigs.get(level);
    if (rig) return rig;
    console.log(`[CoarseRing] create L${level}`);
    const chunks = new Map<string, Chunk>();
    const geometries = new Map<string, ChunkGeometry>();
    const pendingChunks = new Set<string>();
    const grouper = new ChunkGrouper(this.scene);
    const remesh = new RemeshPipeline(
      chunks,
      geometries,
      grouper,
      this.meshPool,
      pendingChunks,
      // Margin source expected = a positive neighbour still pending in THIS ring (so the border meshes
      // once with real data). Neighbours outside the annulus aren't requested → not expected → mesh now
      // (extrapolated; the ring's outer edge cracks against the next level, accepted).
      (cx, cy, cz) => pendingChunks.has(chunkKey(cx, cy, cz)),
      // Coarse rings have no occlusion — every loaded chunk is drawn, so always mesh.
      () => true,
    );
    rig = {
      level, chunks, geometries,
      columnInfo: new Map(),
      pendingChunks,
      pendingColumns: new Set(),
      grouper,
      remesh,
      epoch: 0,
      quiet: false,
      wasQuiet: false,
    };
    // Seam reconciliation across coarse chunks reuses the grouper dirty-mark path (same as the base level).
    remesh.addListener((key) => {
      const gk = grouper.getGroupKey(key);
      if (gk) grouper.markGroupDirty(gk);
    });
    this.rigs.set(level, rig);
    return rig;
  }

  private disposeRig(rig: CoarseLevelRig): void {
    rig.epoch++;                       // invalidate any in-flight generation for this incarnation
    rig.remesh.clear();
    rig.grouper.dispose();
    for (const geo of rig.geometries.values()) geo.dispose();
    rig.chunks.clear();
    rig.geometries.clear();
    rig.columnInfo.clear();
    rig.pendingChunks.clear();
    rig.pendingColumns.clear();
    this.rigs.delete(rig.level);
  }

  /**
   * Stream one coarse ring: request the annulus of surface columns (tiles → chunks), unload what fell
   * outside it, then mesh + merge. `baseLevel` sets the ring radii (ringOuterRadius is base-relative).
   */
  private streamRing(rig: CoarseLevelRig, baseLevel: number): void {
    const L = rig.level;
    const cw = levelChunkWorld(L);                          // true-world metres per level-L chunk
    // Annulus in level-L chunk radii (Chebyshev): [inner, outer] around the level-local centre.
    const inner = ringOuterRadius(L - 1, baseLevel, this._visibilityRadius) / cw;
    const outer = ringOuterRadius(L, baseLevel, this._visibilityRadius) / cw;
    const ccx = this._center.x / cw;                        // level-local fractional chunk centre
    const ccz = this._center.z / cw;
    const rOut = Math.ceil(outer);
    const cxMin = Math.floor(ccx) - rOut, cxMax = Math.floor(ccx) + rOut;
    const czMin = Math.floor(ccz) - rOut, czMax = Math.floor(ccz) + rOut;

    // In-annulus predicate for a column centre (chunk-centre distance, Chebyshev).
    // Inner bound: the INNERMOST coarse ring (base+1) meets the base DISK, whose real rendered extent can
    // fall a little short of the nominal radius — so it ABUTS (inner − 0.5), including the chunk that
    // straddles the boundary, to guarantee no empty band between the base and the first ring (the "1st
    // ring missing" report). Coarser rings meet another coarse ring exactly at the shared radius, so they
    // keep a thin gap (inner + 0.5) to avoid z-fighting their inner neighbour — the accepted crack.
    // Outer bound always includes chunks straddling the far edge (they crack against the next ring).
    const isInnermost = L === baseLevel + 1;
    const innerBound = isInnermost ? inner - 0.5 : inner + 0.5;
    const inAnnulus = (cx: number, cz: number): boolean => {
      const d = Math.max(Math.abs(cx + 0.5 - ccx), Math.abs(cz + 0.5 - ccz));
      return d >= innerBound && d <= outer + 0.5;
    };

    // --- Request pass (throttled): tiles for unknown columns, then their surface chunks ---
    let pending = rig.pendingChunks.size + rig.pendingColumns.size;
    let anyMissing = false;
    for (let cx = cxMin; cx <= cxMax && pending < MAX_PENDING_PER_LEVEL; cx++) {
      for (let cz = czMin; cz <= czMax && pending < MAX_PENDING_PER_LEVEL; cz++) {
        if (!inAnnulus(cx, cz)) continue;
        const colKey = `${cx},${cz}`;
        const info = rig.columnInfo.get(colKey);
        if (!info) {
          if (!rig.pendingColumns.has(colKey)) { this.requestTile(rig, cx, cz); pending++; anyMissing = true; }
          continue;
        }
        for (let cy = info.minCy; cy <= info.maxCy && pending < MAX_PENDING_PER_LEVEL; cy++) {
          const key = chunkKey(cx, cy, cz);
          if (rig.chunks.has(key) || rig.pendingChunks.has(key)) continue;
          this.requestChunk(rig, cx, cy, cz);
          pending++;
          anyMissing = true;
        }
      }
    }

    // --- Unload chunks that fell outside the annulus (+hysteresis) ---
    for (const [key, chunk] of [...rig.chunks]) {
      if (!inAnnulus(chunk.cx, chunk.cz)) {
        const d = Math.max(Math.abs(chunk.cx + 0.5 - ccx), Math.abs(chunk.cz + 0.5 - ccz));
        if (d > outer + RING_UNLOAD_HYSTERESIS || d < inner - RING_UNLOAD_HYSTERESIS) {
          this.unloadChunk(rig, key);
        }
      }
    }

    // --- Mesh + merge for this ring (predicate must reflect THIS level's columnInfo) ---
    setEmptyAirPredicate((cx, cy, cz) => {
      const info = rig.columnInfo.get(`${cx},${cz}`);
      return info ? cy > info.maxCy : false;
    });
    // Level-LOCAL world centre (true-world ÷ 2^L), in the 8 m-per-chunk frame the mesher/grouper use —
    // never touches the shared _center (streamRing runs once per resident level in a loop).
    const ccy = this._center.y / cw;
    this._localCenter.set(ccx * CHUNK_WORLD_SIZE, ccy * CHUNK_WORLD_SIZE, ccz * CHUNK_WORLD_SIZE);
    rig.remesh.process(this._localCenter);
    rig.grouper.rebuild(Math.floor(ccx), Math.floor(ccy), Math.floor(ccz), (k) => rig.remesh.isBusy(k));

    // Wave gate: this ring is "quiet" once nothing is pending and no mesh work remains — the next
    // coarser ring may then begin.
    rig.quiet = !anyMissing && rig.pendingChunks.size === 0 && rig.pendingColumns.size === 0
      && !rig.remesh.hasPendingMeshWork();
    // One-shot settle diagnostic: chunks streamed vs geometry produced tells us, if a ring looks
    // missing, whether it never streamed (0 chunks) or streamed-but-didn't-render (chunks but 0 geo).
    if (rig.quiet && !rig.wasQuiet) {
      let withGeo = 0;
      for (const g of rig.geometries.values()) if (g.hasGeometry()) withGeo++;
      console.log(`[CoarseRing] L${L} settled: ${rig.chunks.size} chunks, ${withGeo} drawn (annulus ${inner.toFixed(1)}..${outer.toFixed(1)} chunks)`);
    }
    rig.wasQuiet = rig.quiet;
  }

  // ---- Generation + ingest (local pool + level-namespaced IDB; mirrors VoxelWorld's local path) ----

  private requestTile(rig: CoarseLevelRig, tx: number, tz: number): void {
    const level = rig.level;
    const colKey = `${tx},${tz}`;
    rig.pendingColumns.add(colKey);
    const epoch = rig.epoch;
    const ok = () => this.rigs.get(level) === rig && rig.epoch === epoch;
    const onTile = (data: MapTileResponse) => { if (ok()) this.receiveTile(rig, data); };
    if (hasColumn(tx, tz, level)) {
      loadColumn(tx, tz, level).then((col) => {
        if (!ok()) return;
        if (col) this.receiveTile(rig, { tx, tz, heights: col.heights, materials: col.materials });
        else this.getLocalPool().requestTile(tx, tz, onTile, level);
      }).catch(() => { if (ok()) this.getLocalPool().requestTile(tx, tz, onTile, level); });
      return;
    }
    this.getLocalPool().requestTile(tx, tz, onTile, level);
  }

  private receiveTile(rig: CoarseLevelRig, data: MapTileResponse): void {
    const { tx, tz, heights, materials } = data;
    rig.pendingColumns.delete(`${tx},${tz}`);
    rig.columnInfo.set(`${tx},${tz}`, columnBand(heights, rig.level));
    if (!hasColumn(tx, tz, rig.level)) saveColumn(tx, tz, heights, materials, rig.level);
  }

  private requestChunk(rig: CoarseLevelRig, cx: number, cy: number, cz: number): void {
    const level = rig.level;
    const key = chunkKey(cx, cy, cz);
    rig.pendingChunks.add(key);
    const epoch = rig.epoch;
    const ok = () => this.rigs.get(level) === rig && rig.epoch === epoch;
    const pKey = this.persistKey(key, level);
    const genAndSave = (d: VoxelChunkData) => { if (!ok()) return; saveChunk(pKey, d.voxelData); this.ingest(rig, d); };
    if (hasChunk(pKey)) {
      loadChunk(pKey).then((saved) => {
        if (!ok()) return;
        if (saved) this.ingest(rig, { chunkX: cx, chunkY: cy, chunkZ: cz, voxelData: saved, lastBuildSeq: 0 });
        else this.getLocalPool().requestChunk(cx, cy, cz, genAndSave, level);
      }).catch(() => { if (ok()) this.getLocalPool().requestChunk(cx, cy, cz, genAndSave, level); });
      return;
    }
    this.getLocalPool().requestChunk(cx, cy, cz, genAndSave, level);
  }

  private ingest(rig: CoarseLevelRig, data: VoxelChunkData): void {
    const { chunkX: cx, chunkY: cy, chunkZ: cz, voxelData } = data;
    const key = chunkKey(cx, cy, cz);
    rig.pendingChunks.delete(key);
    let chunk = rig.chunks.get(key);
    if (!chunk) { chunk = new Chunk(cx, cy, cz); rig.chunks.set(key, chunk); }
    chunk.level = rig.level;                          // grouper roots it at 2^level → true-world size
    chunk.data.set(voxelData);
    chunk.dirty = true;
    this.computeSunlight(rig, cx, cy, cz, chunk.data);
    rig.remesh.add(key);
    // Re-mesh loaded face neighbours so shared borders/light stay consistent as the ring fills in.
    for (const [dx, dy, dz] of FACE_OFFSETS_6) {
      const nKey = chunkKey(cx + dx, cy + dy, cz + dz);
      if (rig.chunks.has(nKey)) rig.remesh.add(nKey);
    }
  }

  /** Sky-light for a coarse chunk: propagated from the chunk above if loaded, else open sky unless the
   *  chunk is fully underground (below the column's lowest surface point) → dark. Mirrors VoxelWorld. */
  private computeSunlight(rig: CoarseLevelRig, cx: number, cy: number, cz: number, data: Uint32Array): void {
    let fromAbove = getSunlitAbove(rig.chunks.get(chunkKey(cx, cy + 1, cz))?.data);
    if (!fromAbove) {
      const info = rig.columnInfo.get(`${cx},${cz}`);
      fromAbove = info && cy < info.minCy ? DARK_ABOVE : null;
    }
    const neighbors = FACE_OFFSETS_6.map(
      ([dx, dy, dz]) => rig.chunks.get(chunkKey(cx + dx, cy + dy, cz + dz))?.data ?? null,
    );
    computeAndPropagateLight(data, fromAbove, neighbors);
  }

  private unloadChunk(rig: CoarseLevelRig, key: string): void {
    rig.grouper.removeChunk(key);
    const geo = rig.geometries.get(key);
    if (geo) { geo.dispose(); rig.geometries.delete(key); }
    rig.remesh.delete(key);
    rig.pendingChunks.delete(key);
    rig.chunks.delete(key);
  }

  /** Drop all rings (world switch / leaving Explore). */
  clear(): void {
    for (const rig of [...this.rigs.values()]) this.disposeRig(rig);
  }

  dispose(): void {
    this.clear();
  }
}
