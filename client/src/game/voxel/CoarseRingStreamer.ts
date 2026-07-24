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
import { TerrainWorkerPool } from './TerrainWorkerPool.js';
import { ringOuterRadius } from './ringLevel.js';
import { hasChunk, loadChunk, saveChunk, hasColumn, loadColumn, saveColumn } from '../world/WorldManager.js';

/** Default coarse ring count until the quality system sets it (Far View control). */
const DEFAULT_COARSE_RINGS = 2;

/** Extra chunks kept loaded beyond a ring's band before unloading (hysteresis, avoids edge thrash). */
const RING_UNLOAD_HYSTERESIS = 1;

/** Margin shell loaded beyond the RENDER band so render-band chunks have real +neighbour voxels to mesh
 *  their high borders once, complete (mirrors the base's margin shell). Loaded but not meshed/drawn. One
 *  chunk thick — the base uses a 1-chunk shell too, and the edge/corner heal (NEGATIVE_MARGIN_OFFSETS_7 on
 *  ingest) already re-meshes consumers when a late diagonal margin lands, so a 2-thick shell only doubled
 *  the settle work per ring (slower to reach quiescence) without closing gaps. */
const MARGIN_RING = 1;

/** Slack on band-boundary comparisons. The outer render row's chunk centres can land exactly on a band
 *  edge (d == renderOuter + 0.5); without slack, float rounding intermittently pushes them just outside,
 *  so that whole row never meshes → the "last row missing" gaps. */
const BAND_EPS = 1e-3;

/** Cap on in-flight requests per coarse level per frame (keeps a ring from starving the base). */
const MAX_PENDING_PER_LEVEL = 12;

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

/**
 * Lowest chunk-Y to LOAD (and mesh) for a column: its own minCy, extended DOWN to the lowest minCy among
 * its 4 face-neighbours. A column beside a LOWER neighbour has an exposed vertical CLIFF WALL running from
 * the neighbour's surface up to its own — chunks that sit BELOW this column's own minCy yet face the
 * neighbour's open sky. `[minCy,maxCy]` alone never loads them, so the wall was missing (the "gaps in the
 * outer rings"). The base level loads them implicitly: its visibility BFS floods the neighbour's open sky
 * and reaches the exposed wall. This mirrors that for the annulus without a full BFS — bounded by terrain
 * relief, self-correcting as neighbour tiles arrive (an absent neighbour doesn't lower the floor yet).
 * Returns Infinity when the column's own tile isn't loaded (nothing to load until it is).
 */
function columnLoadFloor(columnInfo: Map<string, { minCy: number; maxCy: number }>, cx: number, cz: number): number {
  const self = columnInfo.get(`${cx},${cz}`);
  if (!self) return Infinity;
  let floor = self.minCy;
  const n = (dx: number, dz: number): void => {
    const c = columnInfo.get(`${cx + dx},${cz + dz}`);
    if (c && c.minCy < floor) floor = c.minCy;
  };
  n(1, 0); n(-1, 0); n(0, 1); n(0, -1);
  return floor;
}

/** Current per-frame band geometry for a rig, in that level's chunk units. Set each streamRing; read by
 *  the rig's `shouldMeshNow` / `isMarginSourceExpected` closures (which are created once at rig birth). */
interface RigBand {
  ccx: number; ccz: number;   // level-local fractional chunk centre
  innerBound: number;         // render band inner (chunk-centre Chebyshev)
  renderOuter: number;        // render band outer
  requestOuter: number;       // render outer + MARGIN_RING (band we load for neighbour data)
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
  band: RigBand;
  /** Bumped when this rig is torn down, so a late async generation result for the old incarnation drops. */
  epoch: number;
  /** True once this ring has streamed everything in its band and no mesh work remains (wave gate). */
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
  private readonly _colBuf: { cx: number; cz: number; d2: number }[] = [];

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
    const grouper = new ChunkGrouper(this.scene);
    const band: RigBand = { ccx: 0, ccz: 0, innerBound: 0, renderOuter: 0, requestOuter: 0 };
    // Chebyshev chunk-centre distance from the current level-local centre.
    const dist = (cx: number, cz: number) => Math.max(Math.abs(cx + 0.5 - band.ccx), Math.abs(cz + 0.5 - band.ccz));
    // Discrete tiling: a level-L chunk renders iff its CENTRE Chebyshev distance is in
    // [innerBound, renderOuter − 0.5]. The half-cell insets (innerBound = inner + 0.5, and the −0.5 here)
    // make the band's innermost cell's INNER edge land exactly on the ring boundary B_{L-1} = inner·cw_L
    // and its outermost cell's OUTER edge on B_L = outer·cw_L. Because the doubling radii grid-align for
    // an even visibilityRadius (inner = vr/2, outer = vr), ring L's outer edge == ring L+1's inner edge in
    // world space — adjacent rings ABUT with no overlap and no gap (discrete quantised borders).
    const inRenderBand = (cx: number, cz: number) => {
      const d = dist(cx, cz);
      return d >= band.innerBound - BAND_EPS && d <= band.renderOuter - 0.5 + BAND_EPS;
    };
    const remesh = new RemeshPipeline(
      chunks,
      geometries,
      grouper,
      this.meshPool,
      pendingChunks,
      // A +margin neighbour is EXPECTED (defer meshing) only if it will ACTUALLY be requested — mirrors
      // the base's pending/reachable discipline. The streamer only ever requests cy ∈ [minCy, maxCy]
      // per column, so a neighbour above maxCy (open sky) OR below minCy (underground rock beneath the
      // column's lowest surface) is NEVER loaded; a consumer must not wait on either. Missing the
      // below-minCy floor was the permanent ring-edge trench: a surface chunk beside a TALLER column
      // deferred forever on its never-loading underground +X/+Z neighbour and stayed hidden.
      (cx, cy, cz) => {
        const key = chunkKey(cx, cy, cz);
        if (chunks.has(key)) return false;          // already loaded → ready
        if (pendingChunks.has(key)) return true;    // in flight → wait for it
        const d = dist(cx, cz);
        if (d < band.innerBound - BAND_EPS || d > band.requestOuter + 0.5 + BAND_EPS) return false; // out of band → never requested
        const info = columnInfo.get(`${cx},${cz}`);
        if (!info) return true;                      // column tile not in yet, but in-band → it will be requested
        // Loadable span is [exposure floor, maxCy] — the floor is extended down for cliff walls facing a
        // lower neighbour, so a consumer of such a wall chunk correctly waits for it.
        return cy >= columnLoadFloor(columnInfo, cx, cz) && cy <= info.maxCy;
      },
      // Mesh only the RENDER band; the margin ring is loaded for neighbour voxels but never meshed/drawn.
      (cx, _cy, cz) => inRenderBand(cx, cz),
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
      grouper, remesh, band,
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
   * Stream one coarse ring: request its band (render + margin) NEAREST-FIRST, hand off / unload what fell
   * outside, then mesh + merge. Ring radii are base-independent (ringLevel), so the annulus is the same
   * regardless of `baseLevel` — the ring is retained across a zoom.
   */
  private streamRing(rig: CoarseLevelRig): void {
    const L = rig.level;
    const cw = levelChunkWorld(L);
    // Base-independent band, in this level's chunk units: inner = vr/2, render outer = vr (the doubling
    // in ringOuterRadius makes both constant across levels), so the ring is flush with the base disk edge.
    const inner = ringOuterRadius(L - 1, this._visibilityRadius) / cw;
    const outer = ringOuterRadius(L, this._visibilityRadius) / cw;
    // GRID-SNAP the ring centre to THIS level's chunk grid (nearest integer cell to the camera). The old
    // fractional centre made the band edges land at fractional positions, so which cells fell in the
    // annulus flipped as the camera moved by sub-chunk amounts — that shimmer dropped the outer row and
    // opened offset-dependent gaps at the borders. With an integer centre the annulus is a fixed,
    // cell-aligned square that only shifts when the camera crosses a whole level-L cell: stable, discrete,
    // quantised edges. Vertical (y) needs no snap — the band is horizontal.
    const ccx = Math.round(this._center.x / cw);
    const ccz = Math.round(this._center.z / cw);
    // Discrete tiling for EVERY ring (no inward overlap): innerBound = inner + 0.5 so the innermost cell's
    // inner edge lands exactly on B_{L-1} = inner·cw_L. Adjacent rings then abut edge-to-edge (see
    // inRenderBand). The base↔ring1 seam is handled the same way — ring1 starts exactly at the base disk's
    // nominal edge; the finerCovers hand-off drops any residual base overshoot so it's covered, not
    // double-drawn.
    const innerBound = inner + 0.5;
    const b = rig.band;
    b.ccx = ccx; b.ccz = ccz; b.innerBound = innerBound; b.renderOuter = outer; b.requestOuter = outer + MARGIN_RING;

    const rReq = Math.ceil(b.requestOuter + 0.5);
    const cx0 = Math.floor(ccx), cz0 = Math.floor(ccz);
    const dist = (cx: number, cz: number) => Math.max(Math.abs(cx + 0.5 - ccx), Math.abs(cz + 0.5 - ccz));

    // --- Collect the request-band columns NEAREST-FIRST (center-out fill) ---
    const cols = this._colBuf;
    cols.length = 0;
    for (let cx = cx0 - rReq; cx <= cx0 + rReq; cx++) {
      for (let cz = cz0 - rReq; cz <= cz0 + rReq; cz++) {
        const d = dist(cx, cz);
        if (d < innerBound - BAND_EPS || d > b.requestOuter + 0.5 + BAND_EPS) continue;
        cols.push({ cx, cz, d2: (cx + 0.5 - ccx) ** 2 + (cz + 0.5 - ccz) ** 2 });
      }
    }
    cols.sort((p, q) => p.d2 - q.d2);

    // --- Request pass (throttled, nearest-first): tiles for unknown columns, then their surface chunks ---
    let pending = rig.pendingChunks.size + rig.pendingColumns.size;
    let anyMissing = false;
    for (let i = 0; i < cols.length && pending < MAX_PENDING_PER_LEVEL; i++) {
      const { cx, cz } = cols[i];
      const colKey = `${cx},${cz}`;
      const info = rig.columnInfo.get(colKey);
      if (!info) {
        if (!rig.pendingColumns.has(colKey)) { this.requestTile(rig, cx, cz); pending++; anyMissing = true; }
        continue;
      }
      // Load from the exposure floor (extended down for cliff walls facing a lower neighbour) to maxCy.
      const floor = columnLoadFloor(rig.columnInfo, cx, cz);
      for (let cy = floor; cy <= info.maxCy && pending < MAX_PENDING_PER_LEVEL; cy++) {
        const key = chunkKey(cx, cy, cz);
        if (rig.chunks.has(key) || rig.pendingChunks.has(key)) continue;
        this.requestChunk(rig, cx, cy, cz);
        pending++;
        anyMissing = true;
      }
    }

    // --- Unload / hand off chunks that fell outside the band ---
    for (const [key, chunk] of [...rig.chunks]) {
      const d = dist(chunk.cx, chunk.cz);
      if (d > b.requestOuter + RING_UNLOAD_HYSTERESIS) {
        this.unloadChunk(rig, key);                            // beyond the ring → gone
      } else if (d < innerBound - RING_UNLOAD_HYSTERESIS) {
        // Crossed inward into the base-disk region: keep drawing this coarse chunk until the base has
        // actually drawn the finer replacement there — then hand off (no vanishing gap while panning).
        if (this.finerCovers((chunk.cx + 0.5) * cw, (chunk.cz + 0.5) * cw)) this.unloadChunk(rig, key);
      }
    }

    // --- Mesh + merge (this rig's RemeshPipeline carries its own injected open-sky predicate) ---
    const ccy = this._center.y / cw;
    this._localCenter.set(ccx * CHUNK_WORLD_SIZE, ccy * CHUNK_WORLD_SIZE, ccz * CHUNK_WORLD_SIZE);
    rig.remesh.process(this._localCenter);
    rig.grouper.rebuild(cx0, Math.floor(ccy), cz0, (k) => rig.remesh.isBusy(k));

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

  /** Current resident coarse-ring count (so VoxelWorld can compute the shared grid-snap unit). */
  getNumRings(): number {
    return this.numRings;
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
