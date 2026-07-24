/**
 * CoarseRingStreamer — Explore's concentric coarse-LOD rings (Phase B).
 *
 * The base (finest) LOD level is streamed by VoxelWorld with the full occlusion-BFS + retire-and-swap
 * machinery, over its own disk. This module renders the COARSER rings BEYOND that disk: for each coarse
 * level L in (base, base+numRings], it streams an ANNULUS of surface columns at that level. Together they
 * form per-distance LOD: fine in the centre, progressively coarser outward (docs §2).
 *
 * It is ISOLATED from the base/play path — each coarse level owns its OWN chunk/geometry maps, remesh
 * pipeline, and grouper (a `CoarseLevelRig`), so overlapping bare chunk coords never collide. But it now
 * mirrors the base level's streaming DISCIPLINE so the rings behave like the centre:
 *   - Base-independent bands (ringLevel): a level's annulus depends only on its own level, so zooming
 *     retains the outer rings instead of wiping them.
 *   - A request band = render band + a 1-chunk margin ring, plus `shouldMeshNow` (mesh only the render
 *     band) and margin-wait (`isMarginSourceExpected`): a chunk meshes ONCE, complete, with real
 *     neighbour data — never a half-meshed pop-in (mirrors the base's stitch-then-show).
 *   - Requests go out NEAREST-FIRST, and the whole subsystem only streams while the base is quiescent, so
 *     the centre always fills first and the shared worker pools aren't starved (center-out ordering).
 *   - Chunks crossing inward into the base disk are handed off (unloaded only once the base has drawn
 *     that column) so they don't vanish while panning.
 * LOCAL worlds only (server Explore keeps just the base level).
 */

import * as THREE from 'three';
import {
  CHUNK_SIZE,
  CHUNK_WORLD_SIZE,
  MAX_ZOOM_LEVEL,
  FACE_OFFSETS_6,
  NEGATIVE_MARGIN_OFFSETS_7,
  POSITIVE_MARGIN_OFFSETS_7,
  VISIBILITY_UNLOAD_BUFFER,
  chunkKey,
  parseChunkKey,
  worldToChunk,
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
import { TerrainWorkerPool } from './TerrainWorkerPool.js';
import { getVisibleChunks, type ChunkProvider } from './VisibilityBFS.js';
import { hasChunk, loadChunk, saveChunk, hasColumn, loadColumn, saveColumn } from '../world/WorldManager.js';

/** Default coarse ring count until the quality system sets it (Far View control). */
const DEFAULT_COARSE_RINGS = 2;

/** Cap on in-flight requests per coarse level per frame (keeps a ring from starving the base). */
const MAX_PENDING_PER_LEVEL = 12;

/** Shared dummy args for getVisibleChunks: the BFS's cameraDir/frustum are unused (frustum cull disabled
 *  inside it), so every rig passes these module-level constants rather than allocating per frame. */
const DUMMY_DIR = new THREE.Vector3();
const DUMMY_FRUSTUM = new THREE.Frustum();

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
  pendingColumns: Set<string>;
  grouper: ChunkGrouper;
  remesh: RemeshPipeline;
  /** Chunks the visibility BFS reached this pass (the render set). Populated each streamRing, read by the
   *  rig's `shouldMeshNow` / `isMarginSourceExpected` closures (created once at rig birth). Mirrors the
   *  base's `cachedReachable`. */
  reachable: Set<string>;
  /** Bumped when this rig is torn down, so a late async generation result for the old incarnation drops. */
  epoch: number;
  /** True once this ring has streamed everything reachable and no mesh work remains (wave gate). */
  quiet: boolean;
}

export class CoarseRingStreamer {
  private rigs = new Map<number, CoarseLevelRig>();
  private readonly scene: THREE.Scene;
  private readonly meshPool: MeshWorkerPool;
  private readonly getLocalPool: () => TerrainWorkerPool;
  private readonly isLocal: () => boolean;
  private _center = new THREE.Vector3();
  private _localCenter = new THREE.Vector3();
  private _visibilityRadius = 11;
  private numRings = DEFAULT_COARSE_RINGS;
  /** Does the base (finer) level have a drawn surface chunk at this true-world column? Set per update();
   *  gates the inward hand-off so a ring chunk isn't unloaded until the base has covered its footprint. */
  private finerCovers: (worldX: number, worldZ: number) => boolean = () => true;

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
   * Stream + render the coarse rings for the current `baseLevel` around `centerWorld` (TRUE-world metres).
   * `baseQuiet` is true when the base level has nothing left to stream/mesh — coarse rings only stream
   * then, so the centre always fills first (center-out) and the shared worker pools aren't starved.
   * `finerCovers(x,z)` reports whether the base has drawn a given true-world column (for the hand-off).
   * No-op when not local.
   */
  update(
    baseLevel: number,
    centerWorld: THREE.Vector3,
    visibilityRadius: number,
    baseQuiet: boolean,
    finerCovers: (worldX: number, worldZ: number) => boolean,
  ): void {
    if (!this.isLocal()) { this.clear(); return; }
    this._center.copy(centerWorld);
    this._visibilityRadius = visibilityRadius;
    this.finerCovers = finerCovers;

    const maxLevel = Math.min(MAX_ZOOM_LEVEL, baseLevel + this.numRings);

    // Resident-band housekeeping. Existing rings keep their geometry (base-independent bands mean they
    // don't need repositioning), so a zoom retains them instead of wiping them.
    //  - Beyond the band (finer than the base, or past maxLevel) → dispose outright.
    //  - EXACTLY at the base level → this ring was just ABSORBED by the base on a zoom-out. Don't wipe it:
    //    the base is re-streaming the same region at the same level, so hold this ring as backfill and
    //    drop it per-column only once the base has drawn over it (no blank/reset of the inner cube).
    for (const [lvl, rig] of [...this.rigs]) {
      if (lvl < baseLevel || lvl > maxLevel) this.disposeRig(rig);
      else if (lvl === baseLevel) this.holdAbsorbedRig(rig);
    }

    // Center-out priority: don't touch ring streaming until the base is quiescent.
    if (!baseQuiet) return;

    // Stream finest→coarsest. Only CREATING a new deeper ring waits on its inner neighbour being quiet
    // (wave from centre out); existing rings always re-stream so panning keeps them filled.
    for (let level = baseLevel + 1; level <= maxLevel; level++) {
      if (!this.rigs.has(level)) {
        const inner = this.rigs.get(level - 1);
        if (inner && !inner.quiet) break;
      }
      this.streamRing(this.rigForLevel(level));
    }
  }

  private rigForLevel(level: number): CoarseLevelRig {
    let rig = this.rigs.get(level);
    if (rig) return rig;
    const chunks = new Map<string, Chunk>();
    const geometries = new Map<string, ChunkGeometry>();
    const columnInfo = new Map<string, { minCy: number; maxCy: number }>();
    const pendingChunks = new Set<string>();
    const reachable = new Set<string>();
    const grouper = new ChunkGrouper(this.scene);
    const remesh = new RemeshPipeline(
      chunks,
      geometries,
      grouper,
      this.meshPool,
      pendingChunks,
      // A +margin neighbour is EXPECTED (defer meshing) only if it will ACTUALLY load — mirrors the base's
      // isMarginSourceExpected (pending or reachable-but-unloaded). A neighbour above the column's maxCy is
      // genuine open sky (never loads → not expected); everything else that the BFS reached or that's in
      // flight will arrive, so a consumer must wait for it before meshing its shared boundary.
      (cx, cy, cz) => {
        const key = chunkKey(cx, cy, cz);
        if (chunks.has(key)) return false;          // already loaded → ready
        {
          const info = columnInfo.get(`${cx},${cz}`);
          if (info ? cy > info.maxCy : false) return false; // open sky → never loads → not expected
        }
        return pendingChunks.has(key) || reachable.has(key);
      },
      // Mesh only what the BFS reached (the render set) — mirrors the base's shouldMeshChunk. Full 3D key
      // now (cy matters), not a column test: margin-source neighbours are loaded but not reachable, so
      // they're never meshed/drawn.
      (cx, cy, cz) => reachable.has(chunkKey(cx, cy, cz)),
      // Derive completeness from "high face still inbound", not skipHighBoundary — a coarse chunk is only
      // dispatched once nothing is inbound, so a skipped high face is a never-loading solid/out-of-band
      // neighbour (final mesh), not a gap. Prevents ring-edge surface chunks staying hidden forever.
      true,
      // This level's open-sky predicate, injected so the mesher never needs a swapped module global.
      (cx, cy, cz) => {
        const info = columnInfo.get(`${cx},${cz}`);
        return info ? cy > info.maxCy : false;
      },
    );
    rig = {
      level, chunks, geometries, columnInfo,
      pendingChunks,
      pendingColumns: new Set(),
      grouper, remesh, reachable,
      epoch: 0,
      quiet: false,
    };
    const theRig = rig;
    // On each applied mesh: reconcile the group and gate visibility on completeness — a mesh that skipped
    // a high boundary (neighbour absent) is hidden until it re-meshes complete, so rings never show a
    // holed/premature mesh (mirrors the base's isRenderable completeness gate).
    remesh.addListener((key) => {
      const gk = grouper.getGroupKey(key);
      if (gk) grouper.markGroupDirty(gk);
      grouper.setVisible(key, theRig.remesh.isMeshComplete(key));
    });
    this.rigs.set(level, rig);
    return rig;
  }

  /**
   * A ring whose level just became the base level (zoom-out): the base is re-streaming that region at the
   * same level, so keep this ring's geometry visible and hand it off per-column — drop each chunk only
   * once the base has drawn its column (same finer-covers test as the inward pan hand-off). No new
   * streaming for it. Dispose the rig once the base has taken over everything. This is what keeps the
   * inner cube from blanking and re-rendering when it grows on a zoom-out.
   */
  private holdAbsorbedRig(rig: CoarseLevelRig): void {
    const cw = levelChunkWorld(rig.level);
    let removed = false;
    for (const [key, chunk] of [...rig.chunks]) {
      if (this.finerCovers((chunk.cx + 0.5) * cw, (chunk.cz + 0.5) * cw)) { this.unloadChunk(rig, key); removed = true; }
    }
    if (rig.chunks.size === 0) { this.disposeRig(rig); return; }
    if (removed) {
      rig.grouper.rebuild(
        Math.floor(this._center.x / cw), Math.floor(this._center.y / cw), Math.floor(this._center.z / cw),
        (k) => rig.remesh.isBusy(k),
      );
    }
  }

  /** Has this rig DRAWN surface geometry in its (level-local) column (cx,cz)? Used by the coarse↔coarse
   *  hand-off: a coarser ring drops a chunk once a FINER resident ring has actually drawn over it. */
  private rigColumnDrawn(rig: CoarseLevelRig, cx: number, cz: number): boolean {
    const info = rig.columnInfo.get(`${cx},${cz}`);
    if (!info) return false;
    for (let cy = info.minCy; cy <= info.maxCy; cy++) {
      const geo = rig.geometries.get(chunkKey(cx, cy, cz));
      if (geo && geo.hasGeometry()) return true;
    }
    return false;
  }

  /** Is TRUE-world column (worldX,worldZ) already drawn by a level FINER than `rig` — the base disk OR any
   *  finer resident ring? Each ring floods a full cube at its level, so ring L+1 fully overlaps ring L; the
   *  overlap is dropped here (per-column, once the finer level draws it) so exactly one level draws a
   *  column — no double-draw / z-fight between concentric rings. Rings stream finest→coarsest each frame,
   *  so a finer ring's geometry is already current when a coarser one tests it. */
  private coveredByFiner(rig: CoarseLevelRig, worldX: number, worldZ: number): boolean {
    if (this.finerCovers(worldX, worldZ)) return true;   // base disk drew it
    for (const [lvl, other] of this.rigs) {
      if (lvl >= rig.level) continue;                    // only strictly-finer rings hand off inward
      const cwF = levelChunkWorld(lvl);
      if (this.rigColumnDrawn(other, Math.floor(worldX / cwF), Math.floor(worldZ / cwF))) return true;
    }
    return false;
  }

  private disposeRig(rig: CoarseLevelRig): void {
    rig.epoch++;
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
   * Stream one coarse ring driven by the SAME occlusion visibility BFS the base uses (getVisibleChunks),
   * so a ring inherits the base's load / render / exposed-wall behaviour instead of a bespoke annulus
   * band. Runs the BFS in this level's LOCAL space (one chunk = CHUNK_WORLD_SIZE), requests its frontier
   * NEAREST-FIRST, hands off / unloads what fell outside, then meshes + merges.
   */
  private streamRing(rig: CoarseLevelRig): void {
    const L = rig.level;
    const cw = levelChunkWorld(L);                 // true-world size of one level-L chunk (m)
    // Level-LOCAL centre: the rig renders at one chunk = CHUNK_WORLD_SIZE, so the true-world centre scales
    // down by 2^L. localCenter is the centre in this level's metres; cameraChunk its chunk.
    this._localCenter.copy(this._center).multiplyScalar(1 / (1 << L));
    const localCenter = this._localCenter;
    const cameraChunk = worldToChunk(localCenter.x, localCenter.y, localCenter.z);

    // --- Visibility BFS (the SAME traversal the base runs, per rig). reachable = render set, toRequest =
    //     load frontier. cube=true — Explore always uses the cube volume so every level has a complete
    //     shell to swap. cameraDir/frustum are unused inside the BFS → shared dummies. ---
    const provider: ChunkProvider = {
      getChunkByKey: (key) => rig.chunks.get(key),
      isPending: (key) => rig.pendingChunks.has(key),
      isEmptyAir: (cx, cy, cz) => {
        const info = rig.columnInfo.get(`${cx},${cz}`);
        return info ? cy > info.maxCy : false;
      },
    };
    rig.reachable.clear();
    const { reachable, toRequest } = getVisibleChunks(
      cameraChunk, DUMMY_DIR, DUMMY_FRUSTUM, provider, this._visibilityRadius, localCenter, true,
    );
    for (const key of reachable) rig.reachable.add(key);

    // --- Load set = BFS frontier ∪ margin-source neighbours of every reachable chunk (mirrors
    //     VoxelWorld.addMarginSourceRequests): a rendered chunk needs its +margin neighbours' voxels to
    //     mesh its own high faces (READ dep) and its −face owners to draw the shared low boundary. Skip
    //     loaded / pending / open-sky. Bounded: one ring around reachable, no cascade. ---
    const load = new Set<string>(toRequest);
    const addMargin = (nx: number, ny: number, nz: number): void => {
      const nKey = chunkKey(nx, ny, nz);
      if (rig.chunks.has(nKey) || rig.pendingChunks.has(nKey)) return; // already have / coming
      if (provider.isEmptyAir(nx, ny, nz)) return;                     // open sky, won't load
      load.add(nKey);
    };
    for (const key of rig.reachable) {
      const { cx, cy, cz } = parseChunkKey(key);
      for (const [dx, dy, dz] of POSITIVE_MARGIN_OFFSETS_7) addMargin(cx + dx, cy + dy, cz + dz);
      for (const [dx, dy, dz] of FACE_OFFSETS_6) addMargin(cx + dx, cy + dy, cz + dz);
    }

    // --- Request pass (throttled, nearest-first): tiles for unknown columns, then their surface chunks ---
    const lcx = localCenter.x / CHUNK_WORLD_SIZE;
    const lcy = localCenter.y / CHUNK_WORLD_SIZE;
    const lcz = localCenter.z / CHUNK_WORLD_SIZE;
    const d2 = new Map<string, number>();
    const sorted = [...load];
    for (const key of sorted) {
      const { cx, cy, cz } = parseChunkKey(key);
      d2.set(key, (cx + 0.5 - lcx) ** 2 + (cy + 0.5 - lcy) ** 2 + (cz + 0.5 - lcz) ** 2);
    }
    sorted.sort((a, b) => d2.get(a)! - d2.get(b)!);

    let pending = rig.pendingChunks.size + rig.pendingColumns.size;
    let anyMissing = false;
    for (let i = 0; i < sorted.length && pending < MAX_PENDING_PER_LEVEL; i++) {
      const key = sorted[i];
      const { cx, cy, cz } = parseChunkKey(key);
      const colKey = `${cx},${cz}`;
      const info = rig.columnInfo.get(colKey);
      if (!info) {
        // Column tile not in yet → request it (once per column; requestTile adds to pendingColumns).
        if (!rig.pendingColumns.has(colKey)) { this.requestTile(rig, cx, cz); pending++; anyMissing = true; }
        continue;
      }
      if (cy < info.minCy || cy > info.maxCy) continue;         // outside the loadable span (open sky/below)
      if (rig.chunks.has(key) || rig.pendingChunks.has(key)) continue;
      this.requestChunk(rig, cx, cy, cz);
      pending++;
      anyMissing = true;
    }

    // --- Unload / hand off. Keep a loaded chunk if the BFS reached it, it's in the load set, or it's in
    //     flight; else unload once its (level-local) Chebyshev distance from the camera exceeds the
    //     unload radius (hysteresis). Inward hand-off preserved: a chunk whose TRUE-WORLD column is
    //     already drawn by the finer level is handed off (unloaded) so it's covered, never double-drawn. ---
    const unloadRadius = this._visibilityRadius + VISIBILITY_UNLOAD_BUFFER;
    for (const [key, chunk] of [...rig.chunks]) {
      if (this.coveredByFiner(rig, (chunk.cx + 0.5) * cw, (chunk.cz + 0.5) * cw)) { this.unloadChunk(rig, key); continue; }
      if (rig.reachable.has(key) || load.has(key) || rig.pendingChunks.has(key)) continue;
      const dcx = Math.abs(chunk.cx - cameraChunk.cx);
      const dcy = Math.abs(chunk.cy - cameraChunk.cy);
      const dcz = Math.abs(chunk.cz - cameraChunk.cz);
      if (Math.max(dcx, dcy, dcz) > unloadRadius) this.unloadChunk(rig, key);
    }

    // --- Mesh + merge (this rig's RemeshPipeline carries its own injected open-sky predicate) ---
    rig.remesh.process(this._localCenter);
    rig.grouper.rebuild(cameraChunk.cx, cameraChunk.cy, cameraChunk.cz, (k) => rig.remesh.isBusy(k));

    rig.quiet = !anyMissing && rig.pendingChunks.size === 0 && rig.pendingColumns.size === 0
      && !rig.remesh.hasPendingMeshWork();
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
    chunk.level = rig.level;
    chunk.data.set(voxelData);
    chunk.dirty = true;
    this.computeSunlight(rig, cx, cy, cz, chunk.data);
    rig.remesh.add(key);
    // Re-mesh EVERY loaded −neighbour that consumes this chunk as a +margin source — its 7 negative
    // faces/edges/corner (NEGATIVE_MARGIN_OFFSETS_7), not just the 6 faces. A chunk that meshed while this
    // (edge/corner) margin was still absent was tagged incomplete and hidden; re-meshing it now that the
    // margin is present heals it to complete → the visibility gate reveals it. Without the edge/corner
    // directions those consumers never re-meshed → the "last row missing" gaps at ring edges.
    for (const [dx, dy, dz] of NEGATIVE_MARGIN_OFFSETS_7) {
      const nKey = chunkKey(cx + dx, cy + dy, cz + dz);
      if (rig.chunks.has(nKey)) rig.remesh.add(nKey);
    }
  }

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

  /** Set the resident coarse-ring count (Far View quality control). 0 = off. */
  setNumRings(n: number): void {
    this.numRings = Math.max(0, Math.min(MAX_ZOOM_LEVEL, Math.floor(n)));
  }

  /** Aggregate loaded-chunk / drawn-mesh counts across all rings (for the debug overlay). */
  getStats(): { chunks: number; drawn: number } {
    let chunks = 0, drawn = 0;
    for (const rig of this.rigs.values()) {
      chunks += rig.chunks.size;
      for (const g of rig.geometries.values()) if (g.hasGeometry()) drawn++;
    }
    return { chunks, drawn };
  }

  /** Per-ring diagnostics for the debug overlay: for each resident coarse level, how many chunks are
   *  loaded, how many are meshed complete (drawn) vs meshed-but-incomplete (hidden, awaiting a +margin
   *  heal), and whether the ring has settled (quiet). Ordered finest→coarsest. Incomplete counts that
   *  never drain point at a stuck band edge (the "last row missing" gaps). */
  getLevelStats(): { level: number; chunks: number; drawn: number; incomplete: number; quiet: boolean }[] {
    const out: { level: number; chunks: number; drawn: number; incomplete: number; quiet: boolean }[] = [];
    for (const rig of [...this.rigs.values()].sort((a, b) => a.level - b.level)) {
      let drawn = 0, incomplete = 0;
      for (const [key, geo] of rig.geometries) {
        if (!geo.hasGeometry()) continue;
        if (rig.remesh.isMeshComplete(key)) drawn++;
        else incomplete++;
      }
      out.push({ level: rig.level, chunks: rig.chunks.size, drawn, incomplete, quiet: rig.quiet });
    }
    return out;
  }

  /** Per-level solid raycast meshes, each with its LOD scale (2^level), so the spawn raycast can hit ring
   *  terrain (which lives under differently-scaled roots than the base). */
  getSolidMeshesByLevel(): { scale: number; meshes: THREE.Object3D[] }[] {
    const out: { scale: number; meshes: THREE.Object3D[] }[] = [];
    for (const rig of this.rigs.values()) {
      const meshes: THREE.Object3D[] = [];
      for (const geo of rig.geometries.values()) {
        if (geo.hasGeometry()) { const m = geo.getMesh(); if (m) meshes.push(m); }
      }
      if (meshes.length) out.push({ scale: 1 << rig.level, meshes });
    }
    return out;
  }

  /** Drop all rings (world switch / leaving Explore). */
  clear(): void {
    for (const rig of [...this.rigs.values()]) this.disposeRig(rig);
  }

  dispose(): void {
    this.clear();
  }
}
