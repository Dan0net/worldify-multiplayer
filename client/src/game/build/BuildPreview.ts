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
  BuildConfig,
  drawToChunk,
  getAffectedChunks,
  Quat,
  chunkKey,
  CHUNK_SIZE,
  MESH_MARGIN,
  NEGATIVE_FACE_OFFSETS_3,
  voxelIndex,
} from '@worldify/shared';
import { VoxelWorld } from '../voxel/VoxelWorld.js';
import { expandChunkToGrid } from '../voxel/ChunkMesher.js';
import { MeshWorkerPool, type MeshResult } from '../voxel/MeshWorkerPool.js';

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

  /** Cancel function for in-flight batch */
  private cancelBatch: (() => void) | null = null;

  /** Whether a batch is currently in flight */
  private batchInFlight: boolean = false;

  /** Last rendered operation fields for change detection (avoids string hashing) */
  private lastCenter = { x: NaN, y: NaN, z: NaN };
  private lastRotation: Quat = { x: NaN, y: NaN, z: NaN, w: NaN };
  private lastConfig: BuildConfig | null = null;

  /** If aim moved while batch was in flight, store the new operation here */
  private pendingOperation: {
    center: THREE.Vector3;
    rotation: Quat;
    config: BuildConfig;
  } | null = null;

  /** Chunks with preview still visible after commit, waiting for remesh to replace them */
  private pendingCommitChunks: Set<string> = new Set();

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
    config: BuildConfig
  ): void {
    if (!this.world || !this.scene || !this.meshPool) return;

    // Check if operation changed (avoid redundant work)
    if (!this.batchInFlight && this.activePreviewChunks.size > 0 &&
        this.isSameOperation(center, rotation, config)) {
      return; // Already displaying this exact state
    }

    // If a batch is in flight, just store as pending — don't cancel, don't dispatch
    if (this.batchInFlight) {
      this.pendingOperation = { center: center.clone(), rotation, config };
      return;
    }

    // No batch in flight — dispatch immediately
    const operation = this.createOperation(center, rotation, config);
    this.storeOperation(center, rotation, config);
    this.dispatchPreviewBatch(operation);
  }

  /**
   * Dispatch a preview batch to workers. Sets batchInFlight = true.
   * On completion, atomically applies meshes then checks for pending.
   */
  private dispatchPreviewBatch(operation: BuildOperation): void {
    if (!this.world || !this.scene || !this.meshPool) return;

    // Get affected chunks
    const affectedKeys = getAffectedChunks(operation);

    // === Pass 1: Copy temp data and draw operation to ALL affected chunks ===
    // Must complete before grid expansion so boundary reads see drawn neighbors.
    const drawnChunks: string[] = [];
    const drawnSet = new Set<string>();

    for (const key of affectedKeys) {
      const chunk = this.world.chunks.get(key);
      if (!chunk) continue; // Skip unloaded chunks — can't preview into empty space

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

    // === Pass 2: Expand grids and dispatch (neighbors' tempData is now ready) ===
    const batchItems: Array<{
      chunkKey: string;
      grid: Uint16Array;
      skipHighBoundary: [boolean, boolean, boolean];
    }> = [];
    const newActiveChunks = new Set<string>();

    for (const key of drawnChunks) {
      const chunk = this.world.chunks.get(key)!;

      // Expand grid on main thread, dispatch to worker
      const grid = this.meshPool.takeGrid();
      const skipHighBoundary = expandChunkToGrid(chunk, this.world.chunks, grid, true);
      batchItems.push({ chunkKey: key, grid, skipHighBoundary });
      newActiveChunks.add(key);
    }

    // === Pass 2b: Include negative-face neighbors whose high-side margin reads drawn chunk data ===
    for (const key of drawnChunks) {
      const chunk = this.world.chunks.get(key)!;
      const data = chunk.data;
      const temp = chunk.tempData!;

      for (let axis = 0; axis < 3; axis++) {
        if (!BuildPreview.hasBoundaryChanges(data, temp, axis)) continue;
        const [dx, dy, dz] = NEGATIVE_FACE_OFFSETS_3[axis];
        const nk = chunkKey(chunk.cx + dx, chunk.cy + dy, chunk.cz + dz);
        if (newActiveChunks.has(nk)) continue;
        const neighbor = this.world.chunks.get(nk);
        if (!neighbor) continue;
        const grid = this.meshPool.takeGrid();
        const skipHighBoundary = expandChunkToGrid(neighbor, this.world.chunks, grid, true);
        batchItems.push({ chunkKey: nk, grid, skipHighBoundary });
        newActiveChunks.add(nk);
      }
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
      // No chunks to mesh — clear stale previews now
      for (const key of chunksToRemove) {
        this.clearChunkPreview(key);
        this.activePreviewChunks.delete(key);
      }
      return;
    }

    // Mark in flight
    this.batchInFlight = true;

    // Capture refs for async callback
    const world = this.world;
    const scene = this.scene;

    // Dispatch priority batch — callback fires only when ALL chunks complete
    this.cancelBatch = this.meshPool.dispatchBatch(batchItems, (results: MeshResult[]) => {
      this.cancelBatch = null;
      this.batchInFlight = false;

      // Atomic: clear stale chunks + apply new results in the same frame
      for (const key of chunksToRemove) {
        this.clearChunkPreview(key);
        this.activePreviewChunks.delete(key);
      }
      for (const result of results) {
        const chunkMesh = world.meshes.get(result.chunkKey);
        if (!chunkMesh) continue;
        chunkMesh.updatePreviewMeshesFromData(
          result.solid, result.transparent, result.liquid, scene
        );
        chunkMesh.setPreviewActive(true, scene);
      }

      // Check if aim moved while we were working — dispatch pending if so
      this.processPending();
    });
  }

  /**
   * After a batch completes, check if there's a pending operation.
   * If so, dispatch it immediately for a seamless catch-up.
   */
  private processPending(): void {
    if (!this.pendingOperation) return;

    const { center, rotation, config } = this.pendingOperation;
    this.pendingOperation = null;

    // Skip if the pending operation matches what we just rendered
    if (this.isSameOperation(center, rotation, config)) return;

    const operation = this.createOperation(center, rotation, config);
    this.storeOperation(center, rotation, config);
    this.dispatchPreviewBatch(operation);
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
  }

  /**
   * Shared cleanup for holdPreview.
   * Cancels in-flight batch, discards temp data, transfers active preview
   * chunks to pendingCommitChunks (so meshes stay visible until remesh),
   * and resets preview tracking state.
   */
  private endPreview(): void {
    this.cancelInFlightBatch();

    for (const key of this.activePreviewChunks) {
      const chunk = this.world?.chunks.get(key);
      if (chunk) chunk.discardTemp();
      this.pendingCommitChunks.add(key);
    }

    this.activePreviewChunks.clear();
    this.clearLastOperation();
  }

  /**
   * Clear all preview state (e.g., when player switches to non-build tool).
   */
  clearPreview(): void {
    if (!this.world || !this.scene) return;

    this.cancelInFlightBatch();

    for (const key of this.activePreviewChunks) {
      this.clearChunkPreview(key);
    }

    this.activePreviewChunks.clear();
    this.clearLastOperation();
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

    const chunkMesh = this.world.meshes.get(key);
    if (chunkMesh) {
      chunkMesh.setPreviewActive(false, this.scene);
    }
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
    const chunkMesh = this.world.meshes.get(chunkKey);
    if (chunkMesh) {
      chunkMesh.setPreviewActive(false, this.scene);
    }
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
    config: BuildConfig
  ): BuildOperation {
    return {
      center: { x: center.x, y: center.y, z: center.z },
      rotation,
      config,
    };
  }

  /**
   * Check if the given operation matches the last rendered one.
   * Uses direct field comparison — no string allocation.
   */
  private isSameOperation(
    center: THREE.Vector3,
    rotation: Quat,
    config: BuildConfig,
  ): boolean {
    const lc = this.lastCenter;
    const lr = this.lastRotation;
    const lf = this.lastConfig;
    if (!lf) return false;
    // Position: round to 0.01m granularity (matches old hash precision)
    return Math.round(center.x * 100) === Math.round(lc.x * 100) &&
      Math.round(center.y * 100) === Math.round(lc.y * 100) &&
      Math.round(center.z * 100) === Math.round(lc.z * 100) &&
      rotation.x === lr.x && rotation.y === lr.y &&
      rotation.z === lr.z && rotation.w === lr.w &&
      config.shape === lf.shape && config.mode === lf.mode &&
      config.size.x === lf.size.x && config.size.y === lf.size.y &&
      config.size.z === lf.size.z && config.material === lf.material &&
      config.thickness === lf.thickness && config.arcSweep === lf.arcSweep &&
      config.closed === lf.closed;
  }

  /** Store last operation fields for change detection. */
  private storeOperation(
    center: THREE.Vector3,
    rotation: Quat,
    config: BuildConfig,
  ): void {
    this.lastCenter.x = center.x;
    this.lastCenter.y = center.y;
    this.lastCenter.z = center.z;
    this.lastRotation = rotation;
    this.lastConfig = config;
  }

  /** Clear last operation fields (e.g. after endPreview/clearPreview). */
  private clearLastOperation(): void {
    this.lastCenter.x = NaN;
    this.lastCenter.y = NaN;
    this.lastCenter.z = NaN;
    this.lastRotation = { x: NaN, y: NaN, z: NaN, w: NaN };
    this.lastConfig = null;
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

  // ============== Boundary Change Detection ==============

  /**
   * Check if the first MESH_MARGIN voxel layers on the low side of an axis differ
   * between original data and tempData. The mesh grid's high-side margin means
   * only the negative-direction neighbor reads from these layers.
   *
   * @param axis 0=X, 1=Y, 2=Z
   * Returns true as soon as any difference is found (early-exit).
   */
  private static hasBoundaryChanges(
    data: Uint16Array,
    temp: Uint16Array,
    axis: number,
  ): boolean {
    const CS = CHUNK_SIZE;
    const coords = [0, 0, 0];
    for (let layer = 0; layer < MESH_MARGIN; layer++) {
      for (let a = 0; a < CS; a++) {
        for (let b = 0; b < CS; b++) {
          coords[axis] = layer;
          coords[(axis + 1) % 3] = a;
          coords[(axis + 2) % 3] = b;
          const idx = voxelIndex(coords[0], coords[1], coords[2]);
          if (data[idx] !== temp[idx]) return true;
        }
      }
    }
    return false;
  }
}
