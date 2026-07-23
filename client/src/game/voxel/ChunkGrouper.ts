/**
 * ChunkGrouper - Geometry merging for terrain draw-call reduction
 *
 * Instead of drawing each chunk as a separate mesh (hundreds of draw calls),
 * chunks are grouped into spatial buckets (GROUP_GRID³ chunks each) and their
 * geometries are merged into a single BufferGeometry per layer per group.
 *
 * Positions are baked to world space during the merge so the merged mesh sits
 * at the origin with an identity model matrix — no per-vertex transform needed.
 *
 * Shadow culling is applied per group based on the group center distance to
 * the player, using getShadowRadius() from QualityManager.
 */

import * as THREE from 'three';
import { CHUNK_WORLD_SIZE, MESH_MARGIN, VOXEL_SCALE } from '@worldify/shared';
import { createLayerMesh, LAYER_LIQUID, LAYER_COUNT, TERRAIN_ATTRS } from './LayerConfig.js';
import { getShadowRadius } from '../quality/QualityManager.js';

// ---- Constants ----

/** Chunks per axis per spatial group */
const GROUP_GRID = 4;

/**
 * How far a chunk's SurfaceNets geometry can overhang its nominal cube, in world units.
 * The mesher runs over a 34³ grid (CHUNK_SIZE + MESH_MARGIN) and places high-boundary vertices at
 * grid coords up to CHUNK_SIZE + MESH_MARGIN, so geometry extends MESH_MARGIN voxels past the chunk
 * origin cube on the +X/+Y/+Z sides (never negative). Per-chunk geometry already accounts for this
 * (MeshGeometry.CHUNK_MESH_EXTENT); the merged-group bounds must too, or three.js frustum-culls the
 * merged mesh against a box that clips the boundary-crossing verts — they pop in/out with camera angle.
 */
const MESH_OVERHANG = MESH_MARGIN * VOXEL_SCALE;

/** Growth factor when a merged buffer needs to be reallocated */
const BUFFER_GROWTH = 1.5;

/** Per-frame wall-clock budget for merging dirty groups (ms). The real limiter. */
const REBUILD_BUDGET_MS = 2;

/** Hard ceiling on group rebuilds per frame — a safety cap above the time budget. */
const MAX_REBUILDS_PER_FRAME = 16;

/**
 * Safety backstop (ms) for the LOD retiring holder: if the new level never resolves some retiring
 * chunk's region (e.g. it panned out of view before loading), force-dispose the whole retiring set
 * after this long so it can't leak. NOT the normal swap trigger — that's per-chunk coverage.
 */
const RETIRE_BACKSTOP_MS = 8000;

// ---- Interfaces ----

interface ChunkSlot {
  cx: number;
  cy: number;
  cz: number;
  /** World-space origin of this chunk */
  wx: number;
  wy: number;
  wz: number;
  /** Per-layer geometry references (may be null if layer is empty) */
  geometries: (THREE.BufferGeometry | null)[];
  /** Whether this chunk is currently visible */
  visible: boolean;
  /** Key into the groups map */
  groupKey: string;
  /** Per-layer standalone scene meshes shown while the group merge is deferred */
  standaloneMeshes: (THREE.Mesh | null)[];
  /**
   * True iff this chunk's geometry is currently baked into a live (non-disposed)
   * merged mesh of its group. A covered chunk must NOT also show a standalone mesh —
   * that double-draw is the source of the seam/water flicker. Set in rebuildGroup,
   * cleared when the chunk leaves the merged set or its group.
   */
  coveredByMerge: boolean;
  /**
   * Per-layer position of this chunk's vertices within its group's merged buffer, recorded at merge
   * time. Lets a light-only update overwrite just this chunk's lightLevel/blockLight slice in place
   * (updateChunkLight) instead of re-merging the whole group. Null per layer when the chunk didn't
   * contribute geometry to that layer's merge; invalidated (via the group's `dirty` flag) whenever
   * the group re-merges or any member's geometry changes.
   */
  mergedSlices: ({ vertexOffset: number; vertexCount: number } | null)[];
}

/** Tracks pre-allocated buffer capacity per layer so we can reuse them. */
interface LayerBuffers {
  vertexCapacity: number;
  indexCapacity: number;
}

/** A spatial group of chunks whose geometry is merged for draw-call reduction. */
interface ChunkGroup {
  /** Per-layer merged meshes in the scene */
  meshes: (THREE.Mesh | null)[];
  /** Set of chunk keys belonging to this group */
  chunkKeys: Set<string>;
  /** Whether the group needs rebuilding */
  dirty: boolean;
  /** Whether the group has been successfully merged at least once since last dirty */
  merged: boolean;
  /** Center chunk coordinates (for shadow culling distance) */
  centerCx: number;
  centerCy: number;
  centerCz: number;
  /** Per-layer capacity tracking for buffer reuse */
  layerBuffers: (LayerBuffers | null)[];
  /** When true, group is suppressed for build preview — merged mesh hidden,
   *  standalones shown for non-preview chunks. */
  previewSuppressed: boolean;
  /** Chunk keys that are in preview while group is suppressed */
  previewChunkKeys: Set<string>;
  /** When true, suppression is waiting for the group to be merged first. */
  suppressionPending: boolean;
  /** Preview chunk keys saved while suppression is pending */
  pendingPreviewChunkKeys: Set<string>;
}

// ---- Helpers ----

function groupKeyFromChunk(cx: number, cy: number, cz: number): string {
  const gx = Math.floor(cx / GROUP_GRID);
  const gy = Math.floor(cy / GROUP_GRID);
  const gz = Math.floor(cz / GROUP_GRID);
  return `${gx},${gy},${gz}`;
}

function groupCenter(gx: number, gy: number, gz: number): { cx: number; cy: number; cz: number } {
  return {
    cx: gx * GROUP_GRID + (GROUP_GRID >> 1),
    cy: gy * GROUP_GRID + (GROUP_GRID >> 1),
    cz: gz * GROUP_GRID + (GROUP_GRID >> 1),
  };
}

function createEmptyGroup(centerCx: number, centerCy: number, centerCz: number): ChunkGroup {
  return {
    meshes: new Array<THREE.Mesh | null>(LAYER_COUNT).fill(null),
    chunkKeys: new Set(),
    dirty: true,
    merged: false,
    centerCx,
    centerCy,
    centerCz,
    layerBuffers: new Array<LayerBuffers | null>(LAYER_COUNT).fill(null),
    previewSuppressed: false,
    previewChunkKeys: new Set(),
    suppressionPending: false,
    pendingPreviewChunkKeys: new Set(),
  };
}

// ============================================================
// ChunkGrouper
// ============================================================

export class ChunkGrouper {
  private scene: THREE.Scene;
  /**
   * All chunk meshes (standalone + merged) live under this root, not the scene directly, so the whole
   * terrain can be scaled by the LOD zoom factor (2^level) in one place: a level-L chunk is meshed at
   * the usual 0.25 m voxel scale, and the root's scale turns its 8 m footprint into the true 8·2^L m.
   * Play / level 0 keeps scale 1 (identity → transparent). Baked-world-space vertex positions scale
   * about the origin, so both a chunk's origin offset and its voxel size scale together — correct.
   */
  private root: THREE.Group;
  private slots = new Map<string, ChunkSlot>();
  private groups = new Map<string, ChunkGroup>();

  /**
   * LOD transition state. On a level change the CURRENTLY VISIBLE chunks are cloned as individual
   * per-chunk meshes into `retiringRoot` (scaled to the OLD level) so the previous level stays fully
   * visible in true-world space, and each is disposed independently once the new level resolves its
   * world region (reconcileRetiring). Per-CHUNK — not the whole level — so the view is never blank
   * and a fine↔coarse swap happens incrementally. Null when no transition is in flight.
   */
  private retiringRoot: THREE.Group | null = null;
  private retiring: { meshes: THREE.Mesh[]; box: THREE.Box3 }[] = [];
  private retiringSince = 0;

  /** Number of groups with suppressionPending === true (O(1) check). */
  private pendingSuppressionCount = 0;

  // Reusable scratch arrays to avoid per-frame allocations
  private eligibleBuf: { gk: string; group: ChunkGroup; dist: number }[] = [];
  private visibleSlotsBuf: ChunkSlot[] = [];
  private priorityKeysBuf = new Set<string>();
  private groupKeysBuf = new Set<string>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.scene.add(this.root);
  }

  // ---- Public API ----

  /** Set the LOD zoom scale of the whole terrain root (2^level; 1 = play / full detail). */
  setScale(scale: number): void {
    this.root.scale.setScalar(scale);
  }

  /**
   * LOD level change with PER-CHUNK retirement (hold-then-swap, incrementally). Clone the currently
   * VISIBLE chunks' geometry into a retiring holder Group scaled to the OLD level, so the previous
   * level stays fully visible in true-world space; each clone is disposed independently by
   * reconcileRetiring() once the new level resolves that chunk's world region. Clones are independent
   * buffers, so the caller is free to dispose the originals immediately. Then the current live root
   * (its merged group copies + standalones) is disposed and a fresh empty root is installed at
   * `newScale`.
   *
   * If a retirement is ALREADY in flight (a fast multi-level sweep), the existing retiring set — the
   * last COMPLETE level — is KEPT as-is; only the current (partial, intermediate) live root is
   * swapped out. So the level you started the sweep from holds until the final level covers it.
   */
  retireAndReset(newScale: number, oldScale: number): void {
    if (!this.retiringRoot) {
      const holder = new THREE.Group();
      holder.scale.setScalar(oldScale);
      this.scene.add(holder);
      for (const slot of this.slots.values()) {
        if (!slot.visible) continue;
        const meshes: THREE.Mesh[] = [];
        for (let layer = 0; layer < LAYER_COUNT; layer++) {
          const geo = slot.geometries[layer];
          if (!geo || !geo.index || geo.index.count === 0) continue;
          const mesh = createLayerMesh(geo.clone(), layer);
          mesh.frustumCulled = true;
          mesh.castShadow = false;   // transient during the swap — skip shadow-caster cost
          mesh.position.set(slot.wx, slot.wy, slot.wz);
          holder.add(mesh);
          meshes.push(mesh);
        }
        if (meshes.length === 0) continue;
        // Core chunk AABB in TRUE world (level-local origin × oldScale). Used by reconcileRetiring to
        // map this chunk onto the new level's grid — no MESH_OVERHANG (that's only for frustum culling).
        const box = new THREE.Box3(
          new THREE.Vector3(slot.wx * oldScale, slot.wy * oldScale, slot.wz * oldScale),
          new THREE.Vector3(
            (slot.wx + CHUNK_WORLD_SIZE) * oldScale,
            (slot.wy + CHUNK_WORLD_SIZE) * oldScale,
            (slot.wz + CHUNK_WORLD_SIZE) * oldScale,
          ),
        );
        this.retiring.push({ meshes, box });
      }
      if (this.retiring.length > 0) {
        this.retiringRoot = holder;
        this.retiringSince = performance.now();
      } else {
        this.scene.remove(holder);   // nothing visible to retire (e.g. first entry)
      }
    }

    // Swap out the current live root (old or intermediate) and install a fresh one at the new scale.
    this.disposeLiveRoot();
    this.root = new THREE.Group();
    this.root.scale.setScalar(newScale);
    this.scene.add(this.root);
    this.slots.clear();
    this.groups.clear();
    this.pendingSuppressionCount = 0;
  }

  /** Dispose the current live root's meshes (merged group copies + standalones) and detach it. */
  private disposeLiveRoot(): void {
    for (const slot of this.slots.values()) this.removeStandalone(slot);
    for (const gk of [...this.groups.keys()]) this.disposeGroup(gk);
    this.scene.remove(this.root);
  }

  /**
   * Per-frame: dispose each retiring chunk whose world region the new level has RESOLVED (predicate
   * true). This is the per-chunk swap — as each new chunk becomes drawable, the old chunk(s) it covers
   * disappear, so the view is always fully covered. Removes the holder once empty; a backstop timeout
   * force-clears it so a region the new level never loads can't leak. No-op when no transition is live.
   */
  reconcileRetiring(isResolved: (box: THREE.Box3) => boolean): void {
    if (!this.retiringRoot) return;
    const expired = performance.now() - this.retiringSince > RETIRE_BACKSTOP_MS;
    let write = 0;
    for (let i = 0; i < this.retiring.length; i++) {
      const entry = this.retiring[i];
      if (expired || isResolved(entry.box)) {
        for (const m of entry.meshes) { this.retiringRoot.remove(m); m.geometry.dispose(); }
      } else {
        this.retiring[write++] = entry;
      }
    }
    this.retiring.length = write;
    if (this.retiring.length === 0) {
      this.scene.remove(this.retiringRoot);
      this.retiringRoot = null;
    }
  }

  /** Dispose the retiring holder and all its clones immediately (world switch / teardown). */
  private disposeRetiring(): void {
    if (!this.retiringRoot) return;
    for (const entry of this.retiring) {
      for (const m of entry.meshes) m.geometry.dispose();
    }
    this.retiring.length = 0;
    this.scene.remove(this.retiringRoot);
    this.retiringRoot = null;
  }

  /**
   * Register or update a chunk's geometry references.
   * Called after mesh generation completes.
   */
  updateChunk(
    key: string,
    cx: number,
    cy: number,
    cz: number,
    geometries: (THREE.BufferGeometry | null)[],
    worldPos: { x: number; y: number; z: number },
  ): void {
    const gk = groupKeyFromChunk(cx, cy, cz);

    let slot = this.slots.get(key);
    if (slot) {
      slot.geometries = geometries;
      const oldGk = slot.groupKey;
      if (oldGk !== gk) {
        this.removeFromGroup(key, oldGk);
        slot.groupKey = gk;
        slot.cx = cx;
        slot.cy = cy;
        slot.cz = cz;
        slot.wx = worldPos.x;
        slot.wy = worldPos.y;
        slot.wz = worldPos.z;
        slot.coveredByMerge = false; // left its old merged set; new group hasn't baked it
        this.addToGroup(key, gk, cx, cy, cz);
      }
    } else {
      slot = {
        cx, cy, cz,
        wx: worldPos.x,
        wy: worldPos.y,
        wz: worldPos.z,
        geometries,
        visible: true,
        groupKey: gk,
        standaloneMeshes: [null, null, null],
        coveredByMerge: false,
        mergedSlices: [null, null, null],
      };
      this.slots.set(key, slot);
      this.addToGroup(key, gk, cx, cy, cz);
    }

    this.markGroupDirty(gk);

    // Show this chunk immediately via a standalone mesh — but ONLY if it isn't
    // already baked into a live merged mesh. Overlaying a standalone on a
    // still-visible (stale) merged mesh double-draws the chunk and flickers,
    // worst with transparent water. A covered chunk instead shows its stale merged
    // geometry single-drawn until rebuildGroup atomically swaps in the fresh merge.
    const group = this.groups.get(gk);
    if (group && !slot.coveredByMerge) {
      this.showStandalone(slot);
    }
  }

  /**
   * Set visibility for a chunk. Marks the owning group dirty so it is
   * rebuilt on the next rebuild() call.
   */
  setVisible(key: string, visible: boolean): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    if (slot.visible !== visible) {
      slot.visible = visible;
      // Toggle standalone meshes immediately
      for (let i = 0; i < LAYER_COUNT; i++) {
        const m = slot.standaloneMeshes[i];
        if (m) m.visible = visible;
      }
      // Don't dirty the group while it's suppressed for preview —
      // the merged mesh is hidden and will be restored as-is.
      const group = this.groups.get(slot.groupKey);
      if (!group?.previewSuppressed) {
        this.markGroupDirty(slot.groupKey);
      }
    }
  }

  /**
   * Remove a chunk (called from unloadChunk).
   */
  removeChunk(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    this.removeStandalone(slot);
    const gk = slot.groupKey;
    this.slots.delete(key);
    this.removeFromGroup(key, gk);
    this.markGroupDirty(gk);

    // If group is now empty, dispose its scene meshes immediately
    const group = this.groups.get(gk);
    if (group && group.chunkKeys.size === 0) {
      this.disposeGroup(gk);
    }
  }

  /**
   * Rebuild dirty groups. Call once per frame after visibility updates.
   *
   * Groups with suppressionPending are rebuilt with top priority (before
   * distance sort) so preview can show ASAP.
   *
   * @param isBusy Returns true if a chunk key is still being processed.
   *   Groups with ANY busy chunk are skipped to avoid redundant rebuilds.
   */
  /** Per-rebuild() counters for the perf overlay (read via getRebuildStats). */
  private _rebuiltCount = 0;
  private _reallocCount = 0;

  /** Groups rebuilt + buffer reallocations during the last rebuild() call. */
  getRebuildStats(): { rebuilt: number; reallocs: number } {
    return { rebuilt: this._rebuiltCount, reallocs: this._reallocCount };
  }

  /**
   * Set `castShadow` on a group's built meshes from the player's chunk distance. A group
   * casts when its center is within `shadowRadius` chunks (Chebyshev). Liquid never casts.
   * Called every frame for all groups (tracks the player) and after a group is rebuilt.
   */
  private applyGroupShadowCulling(
    group: ChunkGroup,
    playerCx: number,
    playerCy: number,
    playerCz: number,
    shadowRadius: number,
  ): void {
    const dx = Math.abs(group.centerCx - playerCx);
    const dy = Math.abs(group.centerCy - playerCy);
    const dz = Math.abs(group.centerCz - playerCz);
    const inShadow = dx <= shadowRadius && dy <= shadowRadius && dz <= shadowRadius;
    for (let layer = 0; layer < group.meshes.length; layer++) {
      const mesh = group.meshes[layer];
      if (mesh) mesh.castShadow = layer !== LAYER_LIQUID && inShadow;
    }
  }

  rebuild(
    playerCx: number,
    playerCy: number,
    playerCz: number,
    isBusy?: (chunkKey: string) => boolean,
  ): void {
    const shadowRadius = getShadowRadius();
    this._rebuiltCount = 0;
    this._reallocCount = 0;

    // Refresh per-group shadow-casting from the CURRENT player position every frame.
    // rebuildGroup only sets castShadow when a group is actually re-merged, so on stable
    // terrain a group's flag would otherwise stay frozen at whatever the player distance was
    // when it last rebuilt — shadows near the radius edge popped in/out (or never appeared
    // until an unrelated rebuild). This cheap pass (distance compare + bool per built mesh)
    // keeps the shadow set tracking the player.
    for (const group of this.groups.values()) {
      this.applyGroupShadowCulling(group, playerCx, playerCy, playerCz, shadowRadius);
    }

    // === Phase 1: Priority rebuild for groups with pending suppression ===
    for (const [gk, group] of this.groups) {
      if (!group.suppressionPending || !group.dirty) continue;
      group.dirty = false;
      this._rebuiltCount++;
      this.rebuildGroup(gk, group, playerCx, playerCy, playerCz, shadowRadius);
      this.finalizePendingSuppression(gk, group);
    }

    // === Phase 2: Normal dirty groups (distance-sorted, capped, isBusy-gated) ===
    const eligible = this.eligibleBuf;
    eligible.length = 0;

    for (const [gk, group] of this.groups) {
      if (!group.dirty || group.previewSuppressed || group.suppressionPending) continue;

      if (isBusy) {
        let busy = false;
        for (const ck of group.chunkKeys) {
          if (isBusy(ck)) { busy = true; break; }
        }
        if (busy) continue;
      }

      // Sort by the group's NEAREST VISIBLE MEMBER chunk, not its geometric center. A 4³ group spans
      // up to ~3 chunks from center, so center-distance would merge a far chunk in a near-centered
      // group before a near chunk in a far-centered group — the "closest chunk doesn't render first"
      // inversion. Nearest-member (squared Euclidean, matching the request/dispatch metric) drains the
      // groups the player is actually next to first.
      let dist = Infinity;
      for (const ck of group.chunkKeys) {
        const slot = this.slots.get(ck);
        if (!slot || !slot.visible) continue;
        const ddx = slot.cx - playerCx, ddy = slot.cy - playerCy, ddz = slot.cz - playerCz;
        const d = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d < dist) dist = d;
      }
      eligible.push({ gk, group, dist });
    }

    // Nearest-first, then drain to a wall-clock budget (with a hard ceiling) rather
    // than a fixed count: cheap groups catch up faster, an expensive burst spreads
    // across frames instead of spiking. Always do at least one so we make progress.
    if (eligible.length > 1) {
      eligible.sort((a, b) => a.dist - b.dist);
    }

    const budgetEnd = performance.now() + REBUILD_BUDGET_MS;
    const limit = Math.min(eligible.length, MAX_REBUILDS_PER_FRAME);
    for (let i = 0; i < limit; i++) {
      const { gk, group } = eligible[i];
      group.dirty = false;
      this._rebuiltCount++;
      this.rebuildGroup(gk, group, playerCx, playerCy, playerCz, shadowRadius);
      if (performance.now() >= budgetEnd) break;
    }
  }

  // ---- GrouperForSuppression interface ----

  /** Get the group key for a chunk key. */
  getGroupKey(chunkKey: string): string | undefined {
    return this.slots.get(chunkKey)?.groupKey;
  }

  /** Check if a group has a pending suppression flag. */
  isGroupSuppressionPending(groupKey: string): boolean {
    return this.groups.get(groupKey)?.suppressionPending ?? false;
  }

  /**
   * Suppress a single group for build preview. Returns true if immediate.
   * If the group is already suppressed, updates previewChunkKeys in-place
   * (only adjusts the standalone delta — no scene graph churn).
   */
  suppressGroup(gk: string, previewChunkKeys: Set<string>): boolean {
    const group = this.groups.get(gk);
    if (!group) return true;

    // Already suppressed — update preview keys and adjust standalones
    if (group.previewSuppressed) {
      this.updateSuppressionKeys(group, previewChunkKeys);
      return true;
    }

    // Require a CLEAN merged mesh (not just any live one) so a dirty/stale group
    // still defers, exactly as before `merged` was decoupled from `dirty`.
    const hasCleanMergedMesh = group.merged && !group.dirty && group.meshes.some(m => m !== null);

    if (hasCleanMergedMesh) {
      this.applySuppression(group, previewChunkKeys);
      return true;
    }

    // Defer — group hasn't been merged yet (or is stale/dirty)
    if (!group.suppressionPending) {
      group.suppressionPending = true;
      this.pendingSuppressionCount++;
    }
    group.pendingPreviewChunkKeys = new Set(previewChunkKeys);
    this.markGroupDirty(gk);
    return false;
  }

  /**
   * Restore a single group from preview suppression.
   */
  restoreGroup(gk: string): void {
    const group = this.groups.get(gk);
    if (!group) return;

    // Clear any pending suppression that was never finalized
    if (group.suppressionPending) {
      group.suppressionPending = false;
      this.pendingSuppressionCount--;
      group.pendingPreviewChunkKeys.clear();
      return;
    }

    if (!group.previewSuppressed) return;

    group.previewSuppressed = false;
    group.previewChunkKeys.clear();

    const hasMergedMesh = group.merged && group.meshes.some(m => m !== null);

    if (hasMergedMesh && !group.dirty) {
      this.removeGroupStandalones(group);
      for (let i = 0; i < LAYER_COUNT; i++) {
        const m = group.meshes[i];
        if (m) m.visible = true;
      }
    } else {
      // No valid merged mesh — show standalones for ALL visible chunks
      for (const ck of group.chunkKeys) {
        const slot = this.slots.get(ck);
        if (slot && slot.visible) {
          slot.coveredByMerge = false; // not in a live merge; standalone owns the draw
          this.showStandalone(slot);
        }
      }
      group.dirty = true;
      group.merged = false;
    }
  }

  /**
   * Mark the group owning a chunk dirty so it re-merges next frame. Used by the light-only
   * relight path: the chunk's geometry attributes (lightLevel/blockLight) were rewritten in
   * place, so the merged buffer must re-copy them — but no re-mesh happened. No-op if the
   * chunk isn't grouped yet.
   */
  markChunkDirty(chunkKey: string): void {
    const gk = this.slots.get(chunkKey)?.groupKey;
    if (gk) this.markGroupDirty(gk);
  }

  /**
   * Light-only update: overwrite just this chunk's lightLevel/blockLight slice in its group's merged
   * buffer, in place — a ranged GPU upload, NOT a full group re-merge. Used after a light-only
   * resample rewrote the chunk geometry's two light attributes. Cheap enough to run for many spill
   * neighbours per frame (the whole point of the light-only relight path).
   *
   * Falls back to a full re-merge (markGroupDirty) when the recorded slice can't be trusted: the
   * group has a pending re-merge, the chunk isn't currently baked into the live merge, or its vertex
   * count changed since the merge. When the group is suppressed for preview the chunk is drawn via a
   * standalone that shares its geometry (already updated by the resample), so there's nothing to copy.
   */
  updateChunkLight(chunkKey: string): void {
    const slot = this.slots.get(chunkKey);
    if (!slot) return;
    const group = this.groups.get(slot.groupKey);
    if (!group) return;

    // Suppressed → shown via a standalone that shares the (already-resampled) geometry.
    if (group.previewSuppressed) return;

    // Stale slices (a re-merge is pending or the chunk isn't in the current merge) → full re-merge.
    if (group.dirty || !group.merged || !slot.coveredByMerge) {
      this.markGroupDirty(slot.groupKey);
      return;
    }

    for (let layer = 0; layer < LAYER_COUNT; layer++) {
      const slice = slot.mergedSlices[layer];
      const src = slot.geometries[layer];
      const mesh = group.meshes[layer];
      if (!slice || !src || !mesh) continue;

      const srcLight = src.getAttribute('lightLevel') as THREE.BufferAttribute | undefined;
      const srcBlock = src.getAttribute('blockLight') as THREE.BufferAttribute | undefined;
      if (!srcLight || !srcBlock) continue;

      // Geometry changed since the merge → offsets are stale; re-merge instead.
      if (srcLight.count !== slice.vertexCount) {
        this.markGroupDirty(slot.groupKey);
        return;
      }

      const merged = mesh.geometry;
      const dstLight = merged.getAttribute('lightLevel') as THREE.BufferAttribute;
      const dstBlock = merged.getAttribute('blockLight') as THREE.BufferAttribute;
      (dstLight.array as Float32Array).set(srcLight.array as Float32Array, slice.vertexOffset);
      (dstBlock.array as Float32Array).set(srcBlock.array as Float32Array, slice.vertexOffset);
      dstLight.addUpdateRange(slice.vertexOffset, slice.vertexCount);
      dstLight.needsUpdate = true;
      dstBlock.addUpdateRange(slice.vertexOffset, slice.vertexCount);
      dstBlock.needsUpdate = true;
    }
  }

  /** Mark a group as dirty so rebuild() processes it. */
  markGroupDirty(gk: string): void {
    const group = this.groups.get(gk);
    if (group) {
      group.dirty = true;
      // NOTE: do NOT clear `merged` here. `merged` means "a live baked mesh exists"
      // (kept visible, single-drawn, until rebuildGroup swaps it), independent of
      // `dirty` ("rebuild pending"). Clearing it would let updateChunk overlay a
      // standalone on the still-visible merged mesh → the double-draw flicker.
    }
  }

  // ---- High-level preview helpers (used by BuildPreview) ----

  /**
   * Suppress groups containing the given preview chunks.
   * Groups that were suppressed but are no longer needed are restored.
   * Groups that remain suppressed get their previewChunkKeys updated (no churn).
   * @returns true if ALL groups were suppressed immediately.
   */
  suppressGroupsForChunks(previewChunkKeys: Set<string>): boolean {
    // Collect which groups are needed
    const neededGroups = this.groupKeysBuf;
    neededGroups.clear();
    for (const ck of previewChunkKeys) {
      const gk = this.getGroupKey(ck);
      if (gk) neededGroups.add(gk);
    }

    // Restore groups that are no longer needed
    for (const [gk, group] of this.groups) {
      if ((group.previewSuppressed || group.suppressionPending) && !neededGroups.has(gk)) {
        this.restoreGroup(gk);
      }
    }

    // Suppress (or update) needed groups
    let allImmediate = true;
    for (const gk of neededGroups) {
      if (!this.suppressGroup(gk, previewChunkKeys)) {
        allImmediate = false;
      }
    }
    return allImmediate;
  }

  /**
   * Restore all currently suppressed groups.
   */
  restoreAllSuppressedGroups(): void {
    for (const [gk, group] of this.groups) {
      if (group.previewSuppressed || group.suppressionPending) {
        this.restoreGroup(gk);
      }
    }
  }

  /**
   * Restore a group if none of the given pending chunk keys belong to it.
   * Used after a committed preview chunk's remesh arrives.
   */
  restoreGroupIfComplete(chunkKey: string, pendingKeys: Set<string>): void {
    const gk = this.getGroupKey(chunkKey);
    if (!gk) return;

    const group = this.groups.get(gk);
    if (!group || (!group.previewSuppressed && !group.suppressionPending)) return;

    // Don't restore if other pending commit chunks are still in this group
    for (const ck of group.chunkKeys) {
      if (pendingKeys.has(ck)) return;
    }
    this.restoreGroup(gk);
  }

  /**
   * Check if any groups have pending suppressions (waiting for merge).
   */
  hasPendingSuppressions(): boolean {
    return this.pendingSuppressionCount > 0;
  }

  /**
   * Get chunk keys in groups with pending suppressions.
   * Used to prioritize these chunks in the remesh queue.
   */
  getPriorityChunkKeys(): Set<string> {
    const keys = this.priorityKeysBuf;
    keys.clear();
    if (this.pendingSuppressionCount === 0) return keys;
    for (const group of this.groups.values()) {
      if (!group.suppressionPending) continue;
      for (const ck of group.chunkKeys) keys.add(ck);
    }
    return keys;
  }

  /**
   * Dispose everything.
   */
  dispose(): void {
    for (const slot of this.slots.values()) {
      this.removeStandalone(slot);
    }
    for (const gk of this.groups.keys()) {
      this.disposeGroup(gk);
    }
    this.groups.clear();
    this.slots.clear();
    // Drop any in-flight LOD retirement (its clones) too, so a world switch leaves nothing behind.
    this.disposeRetiring();
    // Reset the root scale so a reused grouper (clearAndReload keeps the same instance) starts at
    // level 0.
    this.root.scale.setScalar(1);
  }

  // ---- Private: suppression helpers ----

  /** Apply immediate suppression: hide merged mesh, show standalones for non-preview chunks. */
  private applySuppression(group: ChunkGroup, previewChunkKeys: Set<string>): void {
    group.previewSuppressed = true;
    group.previewChunkKeys = new Set(previewChunkKeys);
    if (group.suppressionPending) {
      group.suppressionPending = false;
      this.pendingSuppressionCount--;
    }
    group.pendingPreviewChunkKeys.clear();

    for (let i = 0; i < LAYER_COUNT; i++) {
      const m = group.meshes[i];
      if (m) m.visible = false;
    }
    for (const ck of group.chunkKeys) {
      if (previewChunkKeys.has(ck)) continue;
      const slot = this.slots.get(ck);
      if (slot && slot.visible) this.showStandalone(slot);
    }
  }

  /**
   * Update preview chunk keys on an already-suppressed group.
   * Only adjusts standalones for the delta — no full teardown/rebuild.
   */
  private updateSuppressionKeys(group: ChunkGroup, newPreviewChunkKeys: Set<string>): void {
    const oldKeys = group.previewChunkKeys;

    for (const ck of group.chunkKeys) {
      const wasPreview = oldKeys.has(ck);
      const isPreview = newPreviewChunkKeys.has(ck);

      if (wasPreview && !isPreview) {
        // Chunk left preview — show its standalone
        const slot = this.slots.get(ck);
        if (slot && slot.visible) this.showStandalone(slot);
      } else if (!wasPreview && isPreview) {
        // Chunk entered preview — remove its standalone (preview mesh takes over)
        const slot = this.slots.get(ck);
        if (slot) this.removeStandalone(slot);
      }
    }

    group.previewChunkKeys = new Set(newPreviewChunkKeys);
  }

  /** Finalize a pending suppression after the group has been rebuilt. */
  private finalizePendingSuppression(_gk: string, group: ChunkGroup): void {
    const previewChunkKeys = group.pendingPreviewChunkKeys;
    if (group.suppressionPending) {
      group.suppressionPending = false;
      this.pendingSuppressionCount--;
    }
    group.pendingPreviewChunkKeys = new Set();
    this.applySuppression(group, previewChunkKeys);
  }

  // ---- Private: group bookkeeping ----

  private addToGroup(chunkKey: string, gk: string, _cx: number, _cy: number, _cz: number): void {
    let group = this.groups.get(gk);
    if (!group) {
      const parts = gk.split(',');
      const center = groupCenter(
        parseInt(parts[0], 10),
        parseInt(parts[1], 10),
        parseInt(parts[2], 10),
      );
      group = createEmptyGroup(center.cx, center.cy, center.cz);
      this.groups.set(gk, group);
    }
    group.chunkKeys.add(chunkKey);
  }

  private removeFromGroup(chunkKey: string, gk: string): void {
    const group = this.groups.get(gk);
    if (group) group.chunkKeys.delete(chunkKey);
    const slot = this.slots.get(chunkKey);
    if (slot) slot.coveredByMerge = false; // no longer part of this group's merge
  }

  // ---- Private: standalone mesh management ----

  /** Show individual chunk meshes in the scene (shared geometry, no copy). */
  private showStandalone(slot: ChunkSlot): void {
    for (let layer = 0; layer < LAYER_COUNT; layer++) {
      const geo = slot.geometries[layer];
      const existing = slot.standaloneMeshes[layer];

      if (!geo || !geo.index || geo.index.count === 0) {
        if (existing) {
          this.root.remove(existing);
          slot.standaloneMeshes[layer] = null;
        }
        continue;
      }

      if (existing) {
        existing.geometry = geo;
        existing.position.set(slot.wx, slot.wy, slot.wz);
        existing.visible = slot.visible;
      } else {
        const mesh = createLayerMesh(geo, layer);
        mesh.frustumCulled = true;
        mesh.position.set(slot.wx, slot.wy, slot.wz);
        mesh.visible = slot.visible;
        this.root.add(mesh);
        slot.standaloneMeshes[layer] = mesh;
      }
    }
  }

  /** Remove all standalone meshes for a slot from the scene. */
  private removeStandalone(slot: ChunkSlot): void {
    for (let layer = 0; layer < LAYER_COUNT; layer++) {
      const m = slot.standaloneMeshes[layer];
      if (m) {
        this.root.remove(m);
        slot.standaloneMeshes[layer] = null;
      }
    }
  }

  /** Remove standalone meshes for all chunks in a group. */
  private removeGroupStandalones(group: ChunkGroup): void {
    for (const ck of group.chunkKeys) {
      const slot = this.slots.get(ck);
      if (slot) this.removeStandalone(slot);
    }
  }

  private disposeGroup(gk: string): void {
    const group = this.groups.get(gk);
    if (!group) return;
    for (let i = 0; i < LAYER_COUNT; i++) {
      const m = group.meshes[i];
      if (m) {
        this.root.remove(m);
        m.geometry.dispose();
        group.meshes[i] = null;
      }
      group.layerBuffers[i] = null;
    }
    this.groups.delete(gk);
  }

  // ---- Private: merge & rebuild ----

  private rebuildGroup(
    _gk: string,
    group: ChunkGroup,
    playerCx: number,
    playerCy: number,
    playerCz: number,
    shadowRadius: number,
  ): void {
    this.removeGroupStandalones(group);

    // Tracks whether any layer produced a live merged mesh this rebuild.
    let anyLayerBuilt = false;

    // Collect visible chunk slots
    const visibleSlots = this.visibleSlotsBuf;
    visibleSlots.length = 0;
    for (const ck of group.chunkKeys) {
      const slot = this.slots.get(ck);
      if (slot && slot.visible) visibleSlots.push(slot);
    }

    for (let layer = 0; layer < LAYER_COUNT; layer++) {
      const existing = group.meshes[layer];

      // Count totals directly from visible slots (avoids per-rebuild object allocations)
      let totalVerts = 0;
      let totalIndices = 0;
      for (let si = 0; si < visibleSlots.length; si++) {
        const geo = visibleSlots[si].geometries[layer];
        if (geo && geo.index && geo.index.count > 0) {
          totalVerts += geo.getAttribute('position').count;
          totalIndices += geo.index.count;
        }
      }

      if (totalVerts === 0) {
        if (existing) existing.visible = false;
        continue;
      }
      anyLayerBuilt = true;

      // Check if existing GPU buffers can be reused
      const lb = group.layerBuffers[layer];
      const canReuse = !!(existing && lb &&
        totalVerts <= lb.vertexCapacity &&
        totalIndices <= lb.indexCapacity);

      let merged: THREE.BufferGeometry;

      if (canReuse) {
        merged = existing!.geometry;
      } else {
        this._reallocCount++;
        const vertCap = Math.ceil(totalVerts * BUFFER_GROWTH);
        const idxCap = Math.ceil(totalIndices * BUFFER_GROWTH);

        merged = new THREE.BufferGeometry();
        for (const attr of TERRAIN_ATTRS) {
          merged.setAttribute(
            attr.name,
            new THREE.BufferAttribute(new Float32Array(vertCap * attr.itemSize), attr.itemSize),
          );
        }
        merged.setIndex(new THREE.BufferAttribute(new Uint32Array(idxCap), 1));
        group.layerBuffers[layer] = { vertexCapacity: vertCap, indexCapacity: idxCap };
      }

      // ---- Fill attribute data (iterate visibleSlots directly — zero alloc) ----
      for (const attr of TERRAIN_ATTRS) {
        const dstAttr = merged.getAttribute(attr.name) as THREE.BufferAttribute;
        const arr = dstAttr.array as Float32Array;
        let vertOffset = 0;

        if (attr.name === 'position') {
          // Bake positions into world space
          for (let si = 0; si < visibleSlots.length; si++) {
            const slot = visibleSlots[si];
            const geo = slot.geometries[layer];
            if (!geo || !geo.index || geo.index.count === 0) continue;
            const srcAttr = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
            if (!srcAttr) continue;
            const srcArr = srcAttr.array as Float32Array;
            const { wx, wy, wz } = slot;
            for (let v = 0; v < srcAttr.count; v++) {
              const sBase = v * 3;
              const dBase = (vertOffset + v) * 3;
              arr[dBase] = srcArr[sBase] + wx;
              arr[dBase + 1] = srcArr[sBase + 1] + wy;
              arr[dBase + 2] = srcArr[sBase + 2] + wz;
            }
            vertOffset += srcAttr.count;
          }
        } else {
          for (let si = 0; si < visibleSlots.length; si++) {
            const geo = visibleSlots[si].geometries[layer];
            if (!geo || !geo.index || geo.index.count === 0) continue;
            const srcAttr = geo.getAttribute(attr.name) as THREE.BufferAttribute | undefined;
            if (!srcAttr) continue;
            arr.set(srcAttr.array as Float32Array, vertOffset * attr.itemSize);
            vertOffset += srcAttr.count;
          }
        }

        dstAttr.clearUpdateRanges();
        dstAttr.addUpdateRange(0, totalVerts * attr.itemSize);
        dstAttr.needsUpdate = true;
      }

      // ---- Fill index buffer + record each chunk's vertex slice (for light-only updates) ----
      const idxAttr = merged.index!;
      const indices = idxAttr.array as Uint32Array;
      let idxOffset = 0;
      let vertBase = 0;
      for (let si = 0; si < visibleSlots.length; si++) {
        const slot = visibleSlots[si];
        const geo = slot.geometries[layer];
        if (!geo || !geo.index || geo.index.count === 0) {
          slot.mergedSlices[layer] = null;
          continue;
        }
        const vertCount = geo.getAttribute('position').count;
        slot.mergedSlices[layer] = { vertexOffset: vertBase, vertexCount: vertCount };
        const srcIdx = geo.index;
        const srcArr = srcIdx.array;
        for (let i = 0; i < srcIdx.count; i++) {
          indices[idxOffset + i] = srcArr[i] + vertBase;
        }
        idxOffset += srcIdx.count;
        vertBase += vertCount;
      }
      idxAttr.clearUpdateRanges();
      idxAttr.addUpdateRange(0, totalIndices);
      idxAttr.needsUpdate = true;
      merged.setDrawRange(0, totalIndices);

      // ---- Compute bounding box from chunk world positions ----
      // We must set this manually because:
      //  (a) Three.js caches boundingSphere and won't recompute on buffer reuse
      //  (b) Over-allocated buffers have zero-filled tails that poison auto-computation
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let si = 0; si < visibleSlots.length; si++) {
        const slot = visibleSlots[si];
        const geo = slot.geometries[layer];
        if (!geo || !geo.index || geo.index.count === 0) continue;
        if (slot.wx < minX) minX = slot.wx;
        if (slot.wy < minY) minY = slot.wy;
        if (slot.wz < minZ) minZ = slot.wz;
        // Include the high-side mesh overhang so boundary-crossing verts stay inside the merged
        // bounding box (and thus its frustum-cull sphere). Low side never overhangs.
        const ex = slot.wx + CHUNK_WORLD_SIZE + MESH_OVERHANG;
        const ey = slot.wy + CHUNK_WORLD_SIZE + MESH_OVERHANG;
        const ez = slot.wz + CHUNK_WORLD_SIZE + MESH_OVERHANG;
        if (ex > maxX) maxX = ex;
        if (ey > maxY) maxY = ey;
        if (ez > maxZ) maxZ = ez;
      }
      if (!merged.boundingBox) merged.boundingBox = new THREE.Box3();
      merged.boundingBox.min.set(minX, minY, minZ);
      merged.boundingBox.max.set(maxX, maxY, maxZ);
      if (!merged.boundingSphere) merged.boundingSphere = new THREE.Sphere();
      merged.boundingBox.getBoundingSphere(merged.boundingSphere);

      // ---- Attach geometry to mesh if new allocation ----
      if (!canReuse) {
        if (existing) {
          const old = existing.geometry;
          existing.geometry = merged;
          old.dispose();
          existing.visible = true;
        } else {
          const mesh = createLayerMesh(merged, layer);
          mesh.frustumCulled = true;
          mesh.position.set(0, 0, 0);
          this.root.add(mesh);
          group.meshes[layer] = mesh;
        }
      } else {
        existing!.visible = true;
      }

    }

    // Shadow-casting for the freshly built meshes (same rule as the per-frame refresh).
    this.applyGroupShadowCulling(group, playerCx, playerCy, playerCz, shadowRadius);

    // `merged` = a live baked mesh now exists for this group (independent of `dirty`).
    // Mark every visible chunk as covered so updateChunk won't overlay a standalone
    // on it; non-visible chunks are not in the merge, so clear their coverage.
    group.merged = anyLayerBuilt;
    for (const ck of group.chunkKeys) {
      const slot = this.slots.get(ck);
      if (slot) slot.coveredByMerge = anyLayerBuilt && slot.visible;
    }
  }
}
