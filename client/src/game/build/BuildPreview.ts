/**
 * BuildPreview - Coordinates voxel preview rendering for the build system
 * 
 * When the player aims at terrain with a build tool selected, this class:
 * 1. Copies affected chunk data to tempData buffers
 * 2. Draws the build operation to tempData (non-destructive preview)
 * 3. Dispatches preview chunks to worker pool as a priority batch
 * 4. When ALL results return, atomically swaps preview meshes (no tearing)
 * 5. If aim moved while batch was in flight, immediately dispatches again
 * 6. Manages cleanup when preview ends or position changes
 * 
 * Key pattern: "let it finish, then catch up"
 * - Never cancels a batch just because aim moved (wastes worker cycles)
 * - Instead stores pendingOperation and dispatches after current batch completes
 * - This ensures preview ALWAYS displays, just possibly one batch-cycle behind cursor
 */

import * as THREE from 'three';
import {
  BuildOperation,
  BuildPart,
  drawToChunk,
  getAffectedChunks,
  Quat,
  chunkKey,
  CHUNK_SIZE,
  MESH_MARGIN,
  NEGATIVE_MARGIN_OFFSETS_7,
  voxelIndex,
} from '@worldify/shared';
import { VoxelWorld } from '../voxel/VoxelWorld.js';
import { expandChunkToGrid } from '../voxel/ChunkMesher.js';
import { MeshWorkerPool, type MeshResult } from '../voxel/MeshWorkerPool.js';
import { createBufferGeometry } from '../voxel/MeshGeometry.js';
import { createLayerMesh, LAYER_COUNT } from '../voxel/LayerConfig.js';

/**
 * BuildPreview manages non-destructive voxel preview rendering.
 * Uses worker pool for off-thread meshing with atomic batch apply.
 */
export class BuildPreview {
  /** The voxel world to preview in */
  private world: VoxelWorld | null = null;

  /** Scene for adding/removing preview meshes */
  private scene: THREE.Scene | null = null;

  /** Worker pool (shared with VoxelWorld via reference) */
  private meshPool: MeshWorkerPool | null = null;

  /** Set of chunk keys currently showing preview */
  private activePreviewChunks: Set<string> = new Set();

  /** Spill neighbours (not drawn) whose displayed light is overridden with preview light. Tracked
   *  so they can be restored to committed light when they leave the preview region or it ends. */
  private previewSpillKeys: Set<string> = new Set();

  /** Cancel function for in-flight batch */
  private cancelBatch: (() => void) | null = null;

  /** Whether a mesh batch is currently in flight */
  private batchInFlight: boolean = false;

  /** Last rendered operation fields for change detection (avoids string hashing) */
  private lastCenter = { x: NaN, y: NaN, z: NaN };
  private lastRotation: Quat = { x: NaN, y: NaN, z: NaN, w: NaN };
  /** Fingerprint of the last operation's parts; null until something has rendered. */
  private lastPartsFp: string | null = null;

  /** If aim moved while batch was in flight, store the new operation here */
  private pendingOperation: {
    center: THREE.Vector3;
    rotation: Quat;
    parts: BuildPart[];
  } | null = null;

  /** Chunks with preview still visible after commit, waiting for remesh to replace them */
  private pendingCommitChunks: Set<string> = new Set();

  /** Preview results waiting to be made visible (deferred until pending suppressions resolve) */
  private deferredPreviewResults: MeshResult[] | null = null;

  /** Chunks to remove from preview after deferred results are applied */
  private deferredChunksToRemove: string[] | null = null;

  /** The deferred cycle's re-mesh sets, so runDeferredLighting knows what to relight when it fires. */
  private deferredDrawnKeys: string[] | null = null;
  private deferredMarginKeys: string[] | null = null;

  /** Preview meshes per chunk (solid, transparent, liquid slots) */
  private previewMeshes: Map<string, (THREE.Mesh | null)[]> = new Map();

  /** Per-preview-mesh per-layer cell indices, so a preview mesh's light can be resampled in Phase 2. */
  private previewCellIndices: Map<string, (Uint16Array | null)[]> = new Map();

  // Reusable scratch buffers to avoid per-dispatch allocations
  private drawnChunksBuf: string[] = [];
  private drawnSetBuf = new Set<string>();
  private newActiveChunksBuf = new Set<string>();

  /**
   * Set the voxel world, scene, and worker pool to use for preview.
   */
  initialize(world: VoxelWorld, scene: THREE.Scene, meshPool: MeshWorkerPool): void {
    this.world = world;
    this.scene = scene;
    this.meshPool = meshPool;

    // Clean up pendingCommitChunks when chunks unload to prevent leaks
    world.addUnloadListener((key) => {
      this.pendingCommitChunks.delete(key);
    });
  }

  /**
   * Update the preview for a build operation at the given position.
   * Call this every frame when the player is aiming with a build tool.
   * 
   * If a batch is already in flight, stores the operation as pending.
   * When the current batch completes, it checks for pending and dispatches again.
   * This ensures preview always displays (at most one batch-cycle behind cursor).
   */
  updatePreview(
    center: THREE.Vector3,
    rotation: Quat,
    parts: BuildPart[]
  ): void {
    if (!this.world || !this.scene || !this.meshPool) return;

    // Check if operation changed (avoid redundant work)
    if (!this.batchInFlight && this.activePreviewChunks.size > 0 &&
        this.isSameOperation(center, rotation, parts)) {
      return; // Already displaying this exact state
    }

    // If a batch is in flight, just store as pending — don't cancel, don't dispatch
    if (this.batchInFlight) {
      this.pendingOperation = { center: center.clone(), rotation, parts };
      return;
    }

    // No batch in flight — dispatch immediately
    const operation = this.createOperation(center, rotation, parts);
    this.storeOperation(center, rotation, parts);
    this.dispatchPreviewBatch(operation);
  }

  /**
   * Dispatch a preview batch. Sets batchInFlight = true for the whole cycle (lighting + meshing).
   *
   * Two async stages: (1) draw temp (sync) → relight the region on the lighting worker; (2) when
   * light returns, mesh the relit set on the mesh workers and atomically show it. Splitting the
   * relight off the main thread keeps preview smooth even while dragging a torch (per-frame block
   * relight over a 3×3×3). batchInFlight spans both stages, so a cursor move mid-cycle is stored as
   * pendingOperation and dispatched on completion — the existing "let it finish, then catch up".
   */
  private dispatchPreviewBatch(operation: BuildOperation): void {
    if (!this.world || !this.scene || !this.meshPool) return;

    // Get affected chunks
    const affectedKeys = getAffectedChunks(operation);

    // Skip preview entirely if any affected chunk isn't loaded yet.
    // Request the missing ones so they arrive for the next preview cycle.
    if (affectedKeys.some(key => !this.world!.chunks.has(key))) {
      this.world.requestMissingChunks(affectedKeys);
      return;
    }

    // === Pass 1: Copy temp data and draw operation to ALL affected chunks ===
    // Must complete before grid expansion so boundary reads see drawn neighbors.
    const drawnChunks = this.drawnChunksBuf;
    drawnChunks.length = 0;
    const drawnSet = this.drawnSetBuf;
    drawnSet.clear();

    for (const key of affectedKeys) {
      const chunk = this.world.chunks.get(key)!;

      chunk.copyToTemp();
      if (!chunk.tempData) continue;

      const changed = drawToChunk(chunk, operation, chunk.tempData);
      if (changed) {
        drawnChunks.push(key);
        drawnSet.add(key);
      } else {
        // No changes — discard the temp copy
        chunk.discardTemp();
      }
    }

    if (drawnChunks.length === 0) {
      // Aim moved but nothing changed — clear any stale preview and bail (no cycle needed).
      const stale = [...this.activePreviewChunks];
      for (const key of stale) {
        this.clearChunkPreview(key);
        this.activePreviewChunks.delete(key);
      }
      // Also revert any spill light-override still applied from the previous position (Bug 1a) —
      // otherwise moving onto empty space leaves a tinted band on the old neighbours.
      this.restoreSpillLight();
      return;
    }

    // Snapshot drawn keys — drawnChunksBuf is reused on the next dispatch.
    const drawnKeys = drawnChunks.slice();

    // Margin-consumer neighbours: chunks whose +margin (a drawn chunk's boundary) changed, so they
    // must be RE-MESHED (Pass 2b). Give them a temp buffer so Pass 2b can mesh them.
    const marginKeys = this.collectMarginNeighbours(drawnKeys);
    for (const nk of marginKeys) {
      const n = this.world.chunks.get(nk);
      if (n && !n.tempData) n.copyToTemp();
    }

    // PHASE 1 — geometry + drawn/margin light. Relight ONLY the drawn + margin chunks synchronously
    // (cheap: it's the brush footprint + its re-meshed neighbours, no block-light spill), so the mesh
    // bakes their correct light. Without this the moving preview goes dark — each re-mesh rebuilds
    // from temp with inherited (stale) light until the cursor settles. The EXPENSIVE work — spill into
    // neighbour chunks and the boundary resample that samples them — stays deferred to
    // runDeferredLighting(), which fires only once the cursor settles (nothing new to mesh).
    const meshKeys = marginKeys.length ? [...drawnKeys, ...marginKeys] : drawnKeys;
    this.world.relightPreviewMeshSet(meshKeys);

    // Reconcile spill overrides for the NEW cursor position: restore any previously-overridden spill
    // neighbour no longer adjacent to the draw, so stale light bands don't linger on far chunks while
    // dragging (the moving-neighbour flicker). Keys only — cheap; the spill RELIGHT stays deferred to
    // settle. A neighbour that just BECAME drawn/margin keeps its temp (it'll be re-meshed) — we only
    // drop it from tracking so the deferred pass doesn't later revert an in-use chunk.
    if (this.previewSpillKeys.size > 0) {
      const remeshSet = new Set(meshKeys);
      const spillNow = this.world.collectSpillKeys(drawnKeys, remeshSet);
      for (const key of [...this.previewSpillKeys]) {
        if (spillNow.has(key)) continue;
        this.previewSpillKeys.delete(key);
        if (!remeshSet.has(key)) this.world.restorePreviewChunkLight(key);
      }
    }

    this.batchInFlight = true;
    this.dispatchPreviewMesh(drawnKeys, marginKeys);
  }

  /**
   * Mesh the drawn chunk set + the margin-consumer neighbours (both already relit on temp), and
   * atomically show the preview. `marginKeys` come from collectMarginNeighbours().
   */
  private dispatchPreviewMesh(drawnKeys: string[], marginKeys: string[]): void {
    const world = this.world;
    const scene = this.scene;
    const meshPool = this.meshPool;
    if (!world || !scene || !meshPool) { this.batchInFlight = false; return; }

    // === Pass 2: Expand grids for the drawn chunks and dispatch (tempData already relit) ===
    const batchItems: Array<{
      chunkKey: string;
      grid: Uint32Array;
      skipHighBoundary: [boolean, boolean, boolean];
    }> = [];
    const newActiveChunks = this.newActiveChunksBuf;
    newActiveChunks.clear();

    for (const key of drawnKeys) {
      const chunk = world.chunks.get(key);
      if (!chunk || !chunk.tempData) continue;

      const grid = meshPool.takeGrid();
      const skipHighBoundary = expandChunkToGrid(chunk, world.chunks, grid, true);
      batchItems.push({ chunkKey: key, grid, skipHighBoundary });
      newActiveChunks.add(key);
    }

    // === Pass 2b: Mesh the margin-consumer neighbours (relit on temp above) ===
    for (const nk of marginKeys) {
      if (newActiveChunks.has(nk)) continue;
      const neighbor = world.chunks.get(nk);
      if (!neighbor || !neighbor.tempData) continue;
      const grid = meshPool.takeGrid();
      const skipHighBoundary = expandChunkToGrid(neighbor, world.chunks, grid, true);
      batchItems.push({ chunkKey: nk, grid, skipHighBoundary });
      newActiveChunks.add(nk);
    }

    // Capture which old preview chunks to clear — any previously active chunk
    // that is NOT in the new batch needs its preview reverted. Computed AFTER
    // Pass 2b so boundary neighbors aren't incorrectly marked for removal.
    const chunksToRemove: string[] = [];
    for (const key of this.activePreviewChunks) {
      if (!newActiveChunks.has(key)) {
        chunksToRemove.push(key);
      }
    }

    // Keep activePreviewChunks as union of old (still displayed) + new (dispatching)
    // so clearPreview() knows about ALL chunks with visible preview meshes.
    // The callback narrows it down after clearing stale ones.
    for (const key of newActiveChunks) {
      this.activePreviewChunks.add(key);
    }

    if (batchItems.length === 0) {
      // No chunks to mesh — clear stale previews now, end the cycle, catch up on any pending op.
      for (const key of chunksToRemove) {
        this.clearChunkPreview(key);
        this.activePreviewChunks.delete(key);
      }
      this.batchInFlight = false;
      this.processPending();
      return;
    }

    // Dispatch priority batch — callback fires only when ALL chunks complete
    this.cancelBatch = meshPool.dispatchBatch(batchItems, (results: MeshResult[]) => {
      this.cancelBatch = null;
      this.batchInFlight = false;

      // Remove stale chunk keys from active set BEFORE suppressing new groups.
      // This ensures old preview chunks are treated as normal chunks during
      // suppress (they get standalones) rather than being excluded.
      for (const key of chunksToRemove) {
        this.activePreviewChunks.delete(key);
      }

      // Suppress groups that contain new preview chunks.
      // This also restores groups no longer needed and updates already-suppressed
      // groups in-place (no full teardown/rebuild scene graph cycle).
      const allImmediate = this.suppressGroupsForActivePreview();

      if (allImmediate) {
        // Show the geometry immediately. Mesh always wins: if the cursor has already moved on,
        // dispatch the next mesh NOW and skip lighting — the mesh tracks the cursor at full worker
        // cadence. Lighting runs only once the cursor settles (no pending op), in a single atomic
        // pass, so it's never in front of the next mesh and never lands a partial update.
        this.applyPreviewResults(results, chunksToRemove, world, scene);
        // Mesh wins: if the cursor genuinely moved, dispatch the next mesh and skip lighting. Only
        // when nothing new was meshed (cursor settled) run the full relight, once.
        if (!this.processPending()) {
          this.runDeferredLighting(drawnKeys, marginKeys);
        }
      } else {
        // Some groups need to be merged first — defer preview visibility.
        // Store results; finalizeDeferredPreview() picks them up once
        // rebuild() finalizes the pending suppressions.
        //
        // If a previous cycle was still deferred (fast movement into unmerged terrain), fold its
        // pending stale-chunk clears into this batch so they aren't lost — otherwise those far
        // preview meshes never get disposed (Bug 1b).
        if (this.deferredChunksToRemove) {
          for (const k of this.deferredChunksToRemove) chunksToRemove.push(k);
        }
        this.deferredPreviewResults = results;
        this.deferredChunksToRemove = chunksToRemove;
        this.deferredDrawnKeys = drawnKeys;
        this.deferredMarginKeys = marginKeys;
      }
    });
  }

  /**
   * PHASE 2 — all preview lighting, run once the geometry is on screen (off the cursor frame).
   *  1. Relight the re-mesh set (drawn + margin) on temp.
   *  2. Relight the spill neighbours (light-affected but not re-meshed) + refresh their committed
   *     geometry's light.
   *  3. Resample the drawn + margin PREVIEW meshes now that every neighbour is relit — so their
   *     boundary vertices sample the neighbours' updated light (fixes the dark border at edits).
   */
  private runDeferredLighting(drawnKeys: string[], marginKeys: string[]): void {
    const world = this.world;
    if (!world) return;

    world.relightPreviewMeshSet(marginKeys.length ? [...drawnKeys, ...marginKeys] : drawnKeys);

    const meshed = new Set(drawnKeys);
    for (const k of marginKeys) meshed.add(k);
    const spill = new Set(world.relightPreviewSpill(drawnKeys, meshed));
    for (const key of this.previewSpillKeys) {
      if (!spill.has(key)) world.restorePreviewChunkLight(key);
    }
    this.previewSpillKeys = spill;

    for (const key of drawnKeys) this.resamplePreviewMeshLight(key);
    for (const key of marginKeys) this.resamplePreviewMeshLight(key);
  }

  /** Resample one preview mesh's light from its chunk's relit temp grid (light-only, no re-mesh). */
  private resamplePreviewMeshLight(key: string): void {
    const meshes = this.previewMeshes.get(key);
    const cells = this.previewCellIndices.get(key);
    if (meshes && cells && this.world) {
      this.world.resamplePreviewMeshLight(key, meshes, cells);
    }
  }

  /**
   * After a batch completes, check if there's a pending operation.
   * If so, dispatch it immediately for a seamless catch-up.
   */
  /**
   * If a newer cursor position is pending, dispatch it. Returns true iff it actually dispatched a
   * new mesh batch — false when there's nothing pending or the pending op equals what's already on
   * screen (i.e. the cursor has settled). Callers use the return value to decide whether to run the
   * deferred lighting: only when nothing new was meshed.
   */
  private processPending(): boolean {
    if (!this.pendingOperation) return false;

    const { center, rotation, parts } = this.pendingOperation;
    this.pendingOperation = null;

    // Pending matches what we just rendered — the cursor has settled, nothing new to mesh.
    if (this.isSameOperation(center, rotation, parts)) return false;

    const operation = this.createOperation(center, rotation, parts);
    this.storeOperation(center, rotation, parts);
    this.dispatchPreviewBatch(operation);
    return true;
  }

  /**
   * Cancel any in-flight worker batch and reset dispatch state.
   */
  private cancelInFlightBatch(): void {
    if (this.cancelBatch) {
      this.cancelBatch();
      this.cancelBatch = null;
    }
    this.batchInFlight = false;
    this.pendingOperation = null;
    this.deferredPreviewResults = null;
    this.deferredChunksToRemove = null;
    this.deferredDrawnKeys = null;
    this.deferredMarginKeys = null;
  }

  /**
   * Shared cleanup for holdPreview.
   * Cancels in-flight batch, discards temp data, transfers active preview
   * chunks to pendingCommitChunks (so meshes stay visible until remesh),
   * and resets preview tracking state.
   */
  private endPreview(): void {
    this.cancelInFlightBatch();

    // DON'T restore suppressed groups here — preview meshes stay visible
    // until onChunkRemeshed replaces them. Groups will be restored per-chunk
    // as each remesh arrives.

    for (const key of this.activePreviewChunks) {
      const chunk = this.world?.chunks.get(key);
      if (chunk) chunk.discardTemp();
      this.pendingCommitChunks.add(key);
    }

    // Revert the light-only override on spill neighbours (their committed geometry). On a commit the
    // subsequent region relight repaints them with the new committed light; on a cancel this is the
    // full revert.
    this.restoreSpillLight();

    this.activePreviewChunks.clear();
    this.clearLastOperation();
  }

  /**
   * Clear all preview state (e.g., when player switches to non-build tool).
   */
  clearPreview(): void {
    if (!this.world || !this.scene) return;

    this.cancelInFlightBatch();

    // Restore suppressed groups before clearing preview chunks
    this.restoreAllSuppressedGroups();

    // Revert the light-only override on spill neighbours.
    this.restoreSpillLight();

    for (const key of this.activePreviewChunks) {
      this.clearChunkPreview(key);
    }

    // Dispose any remaining preview meshes
    this.disposeAllPreviewMeshes();

    // Clear preview tracking on world
    this.world.previewChunks.clear();
    this.world.markVisibilityDirty();

    this.activePreviewChunks.clear();
    this.clearLastOperation();
  }

  /** Revert the light-only preview override on all tracked spill neighbours (restore committed light). */
  private restoreSpillLight(): void {
    if (this.previewSpillKeys.size === 0 || !this.world) return;
    for (const key of this.previewSpillKeys) {
      this.world.restorePreviewChunkLight(key);
    }
    this.previewSpillKeys.clear();
  }

  /**
   * Clear preview for a single chunk.
   */
  private clearChunkPreview(key: string): void {
    if (!this.world || !this.scene) return;

    const chunk = this.world.chunks.get(key);
    if (chunk) {
      chunk.discardTemp();
    }

    // Remove preview meshes from scene
    this.disposePreviewMeshesForChunk(key);

    // Unmark as preview chunk
    this.world.previewChunks.delete(key);
    this.world.markVisibilityDirty();
  }

  /**
   * Hold preview meshes visible without applying the operation.
   * Call this when the player clicks to place but the server handles the actual commit.
   * Preview meshes stay visible until onChunkRemeshed clears them after the
   * server-confirmed remesh arrives.
   */
  holdPreview(): void {
    if (!this.world || !this.scene) return;
    this.endPreview();
  }

  /**
   * Called by VoxelWorld when a chunk's remesh result arrives.
   * If this chunk had its preview kept visible after commit, clear it now.
   */
  onChunkRemeshed(chunkKey: string): void {
    if (!this.pendingCommitChunks.has(chunkKey)) return;
    this.pendingCommitChunks.delete(chunkKey);

    if (!this.world || !this.scene) return;

    // Remove preview meshes for this chunk
    this.disposePreviewMeshesForChunk(chunkKey);
    this.world.previewChunks.delete(chunkKey);
    this.world.markVisibilityDirty();

    // Restore group only if no other pending commit chunks remain in it
    this.world.chunkGrouper.restoreGroupIfComplete(chunkKey, this.pendingCommitChunks);
  }

  /**
   * Check if preview is currently active.
   */
  hasActivePreview(): boolean {
    return this.activePreviewChunks.size > 0;
  }

  /**
   * Create a BuildOperation from position and config.
   */
  private createOperation(
    center: THREE.Vector3,
    rotation: Quat,
    parts: BuildPart[]
  ): BuildOperation {
    return {
      center: { x: center.x, y: center.y, z: center.z },
      rotation,
      parts,
    };
  }

  /** Cheap change-detection fingerprint for a parts list. */
  private partsFingerprint(parts: BuildPart[]): string {
    let s = '';
    for (const p of parts) {
      const c = p.config;
      s += `${c.shape},${c.mode},${c.size.x},${c.size.y},${c.size.z},${c.material},${c.thickness ?? ''},${c.arcSweep ?? ''},${c.closed ?? ''}@${p.offset.x},${p.offset.y},${p.offset.z};`;
    }
    return s;
  }

  /**
   * Check if the given operation matches the last rendered one.
   * Uses direct field comparison — no string allocation.
   */
  private isSameOperation(
    center: THREE.Vector3,
    rotation: Quat,
    parts: BuildPart[],
  ): boolean {
    const lc = this.lastCenter;
    const lr = this.lastRotation;
    if (this.lastPartsFp === null) return false;
    // Position: round to 0.01m granularity (matches old hash precision)
    return Math.round(center.x * 100) === Math.round(lc.x * 100) &&
      Math.round(center.y * 100) === Math.round(lc.y * 100) &&
      Math.round(center.z * 100) === Math.round(lc.z * 100) &&
      rotation.x === lr.x && rotation.y === lr.y &&
      rotation.z === lr.z && rotation.w === lr.w &&
      this.partsFingerprint(parts) === this.lastPartsFp;
  }

  /** Store last operation fields for change detection. */
  private storeOperation(
    center: THREE.Vector3,
    rotation: Quat,
    parts: BuildPart[],
  ): void {
    this.lastCenter.x = center.x;
    this.lastCenter.y = center.y;
    this.lastCenter.z = center.z;
    this.lastRotation = rotation;
    this.lastPartsFp = this.partsFingerprint(parts);
  }

  /** Clear last operation fields (e.g. after endPreview/clearPreview). */
  private clearLastOperation(): void {
    this.lastCenter.x = NaN;
    this.lastCenter.y = NaN;
    this.lastCenter.z = NaN;
    this.lastRotation = { x: NaN, y: NaN, z: NaN, w: NaN };
    this.lastPartsFp = null;
  }

  // ---- Preview group suppression ----

  /**
   * Suppress terrain batch groups for all currently active preview chunks.
   * @returns true if all groups were suppressed immediately (safe to show preview)
   */
  private suppressGroupsForActivePreview(): boolean {
    if (!this.world || this.activePreviewChunks.size === 0) return true;
    return this.world.chunkGrouper.suppressGroupsForChunks(this.activePreviewChunks);
  }

  /** Restore all currently suppressed terrain batch groups. */
  private restoreAllSuppressedGroups(): void {
    if (!this.world) return;
    this.world.chunkGrouper.restoreAllSuppressedGroups();
  }

  // ---- Deferred preview application ----

  /**
   * Apply preview mesh results: clear stale chunks, show new preview meshes.
   */
  private applyPreviewResults(
    results: MeshResult[],
    chunksToRemove: string[],
    world: VoxelWorld,
    scene: THREE.Scene,
  ): void {
    // Clear old preview meshes (keys already removed from activePreviewChunks
    // in the batch callback, before suppress).
    for (const key of chunksToRemove) {
      this.clearChunkPreview(key);
    }
    for (const result of results) {
      const chunk = world.chunks.get(result.chunkKey);
      if (!chunk) continue;

      const worldPos = chunk.getWorldPosition();
      const data = [result.solid, result.transparent, result.liquid];
      const existing = this.previewMeshes.get(result.chunkKey);
      const meshes: (THREE.Mesh | null)[] = existing ?? [null, null, null];
      // Keep each layer's per-vertex cell indices so Phase 2 can light-resample this preview mesh.
      const cells: (Uint16Array | null)[] = [null, null, null];

      for (let i = 0; i < LAYER_COUNT; i++) {
        cells[i] = data[i]?.cellIndices ?? null;
        const oldMesh = meshes[i];

        if (!data[i]) {
          // No data for this layer — remove old mesh if present
          if (oldMesh) {
            scene.remove(oldMesh);
            oldMesh.geometry.dispose();
            meshes[i] = null;
          }
          continue;
        }

        const geometry = createBufferGeometry(data[i]!);

        if (oldMesh) {
          // Reuse existing mesh — just swap geometry (avoids scene add/remove + material alloc)
          const oldGeo = oldMesh.geometry;
          oldMesh.geometry = geometry;
          oldGeo.dispose();
          oldMesh.position.set(worldPos.x, worldPos.y, worldPos.z);
          oldMesh.visible = true;
        } else {
          // First time this layer has data — create mesh and add to scene
          const mesh = createLayerMesh(geometry, i, chunk.key);
          mesh.userData.isPreview = true;
          mesh.position.set(worldPos.x, worldPos.y, worldPos.z);
          scene.add(mesh);
          meshes[i] = mesh;
        }
      }

      this.previewMeshes.set(result.chunkKey, meshes);
      this.previewCellIndices.set(result.chunkKey, cells);
      world.previewChunks.add(result.chunkKey);
      world.markVisibilityDirty();
    }
  }

  /**
   * Check if deferred preview results can be applied.
   * Call once per frame from the game loop (after chunkGrouper.rebuild()).
   * When pending suppressions are resolved, applies the deferred preview
   * and continues with pending operations.
   */
  finalizeDeferredPreview(): void {
    if (!this.deferredPreviewResults || !this.world || !this.scene) return;

    // Still waiting for groups to be merged?
    if (this.world.chunkGrouper.hasPendingSuppressions()) return;

    // All groups are now merged and suppressed — safe to show preview
    const results = this.deferredPreviewResults;
    const chunksToRemove = this.deferredChunksToRemove ?? [];
    const drawnKeys = this.deferredDrawnKeys ?? [];
    const marginKeys = this.deferredMarginKeys ?? [];
    this.deferredPreviewResults = null;
    this.deferredChunksToRemove = null;
    this.deferredDrawnKeys = null;
    this.deferredMarginKeys = null;

    this.applyPreviewResults(results, chunksToRemove, this.world, this.scene);

    // Mesh wins: if a newer cursor position is waiting, dispatch it now and skip lighting; relight
    // only once the cursor settles (nothing new to mesh), so lighting never delays the next mesh
    // and lands atomically.
    if (!this.processPending()) {
      this.runDeferredLighting(drawnKeys, marginKeys);
    }
  }

  /**
   * The negative-direction neighbours whose high-side margin reads a drawn chunk's changed low
   * boundary — the chunks whose mesh geometry depends on the edit and must be re-meshed. Covers all
   * 7 margin consumers (3 faces + 3 edges + corner), matching the commit path (NEGATIVE_MARGIN_-
   * OFFSETS_7) so preview and commit re-mesh the SAME set: a diagonal neighbour that consumes a
   * touched chunk corner is re-meshed too, so it can't keep a stale (dark) corner/edge boundary. Each
   * neighbour is added only if the specific sub-region it reads actually changed.
   */
  private collectMarginNeighbours(drawnKeys: string[]): string[] {
    const world = this.world;
    if (!world) return [];
    const out: string[] = [];
    const seen = new Set<string>(drawnKeys);
    for (const key of drawnKeys) {
      const chunk = world.chunks.get(key);
      if (!chunk || !chunk.tempData) continue;
      const data = chunk.data;
      const temp = chunk.tempData;
      for (const [dx, dy, dz] of NEGATIVE_MARGIN_OFFSETS_7) {
        // A neighbour reads THIS chunk's low margin only on the axes where its offset is negative;
        // re-mesh it only if that sub-region changed (a face slab, edge bar, or corner cube).
        if (!BuildPreview.hasLowMarginChange(data, temp, dx !== 0, dy !== 0, dz !== 0)) continue;
        const nk = chunkKey(chunk.cx + dx, chunk.cy + dy, chunk.cz + dz);
        if (seen.has(nk) || !world.chunks.has(nk)) continue;
        seen.add(nk);
        out.push(nk);
      }
    }
    return out;
  }

  /**
   * Dispose resources.
   */
  dispose(): void {
    this.clearPreview();
    this.world = null;
    this.scene = null;
    this.meshPool = null;
  }

  // ---- Preview Mesh Management ----

  /** Dispose and remove preview meshes for a single chunk. */
  private disposePreviewMeshesForChunk(key: string): void {
    const meshes = this.previewMeshes.get(key);
    if (!meshes) return;
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      if (m) {
        if (this.scene) this.scene.remove(m);
        m.geometry.dispose();
        meshes[i] = null;
      }
    }
    this.previewMeshes.delete(key);
    this.previewCellIndices.delete(key);
  }

  /** Dispose all preview meshes for all chunks. */
  private disposeAllPreviewMeshes(): void {
    for (const key of this.previewMeshes.keys()) {
      this.disposePreviewMeshesForChunk(key);
    }
    this.previewMeshes.clear();
    this.previewCellIndices.clear();
  }

  // ============== Boundary Change Detection ==============

  /**
   * Whether any voxel in a drawn chunk's LOW margin sub-region changed between committed data and
   * tempData. The region is the intersection of the low MESH_MARGIN slabs on each flagged axis: a
   * full low slab for one axis (a face neighbour reads it), a bar for two (an edge neighbour), a
   * small cube for three (the corner neighbour). This is exactly the sub-region a negative-direction
   * margin consumer reads as its high-side margin, so a change here means that neighbour's boundary
   * geometry is stale and it must re-mesh. Early-exits on the first difference.
   */
  private static hasLowMarginChange(
    data: Uint32Array,
    temp: Uint32Array,
    lowX: boolean,
    lowY: boolean,
    lowZ: boolean,
  ): boolean {
    const CS = CHUNK_SIZE;
    const mx = lowX ? MESH_MARGIN : CS;
    const my = lowY ? MESH_MARGIN : CS;
    const mz = lowZ ? MESH_MARGIN : CS;
    for (let x = 0; x < mx; x++) {
      for (let y = 0; y < my; y++) {
        for (let z = 0; z < mz; z++) {
          const idx = voxelIndex(x, y, z);
          if (data[idx] !== temp[idx]) return true;
        }
      }
    }
    return false;
  }
}
