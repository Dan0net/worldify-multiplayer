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
  parseChunkKey,
  CHUNK_SIZE,
  voxelIndex,
} from '@worldify/shared';
import { VoxelWorld } from '../voxel/VoxelWorld.js';
import { Chunk } from '../voxel/Chunk.js';
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

  /** Hash of operation currently being rendered (in-flight or displayed) */
  private renderedHash: string = '';

  /** The current preview operation (stored for commitPreview) */
  private currentOperation: BuildOperation | null = null;

  /** Cancel function for in-flight batch (only used by clearPreview/commitPreview) */
  private cancelBatch: (() => void) | null = null;

  /** Whether a batch is currently in flight */
  private batchInFlight: boolean = false;

  /** If aim moved while batch was in flight, store the new operation here */
  private pendingOperation: {
    center: THREE.Vector3;
    rotation: Quat;
    config: BuildConfig;
    hash: string;
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

    // Create build operation
    const operation = this.createOperation(center, rotation, config);

    // Check if operation changed (avoid redundant work)
    const hash = this.hashOperation(operation);
    if (hash === this.renderedHash && !this.batchInFlight && this.activePreviewChunks.size > 0) {
      return; // Already displaying this exact state
    }

    // Store current operation for potential commit (always tracks latest)
    this.currentOperation = operation;

    // If a batch is in flight, just store as pending — don't cancel, don't dispatch
    if (this.batchInFlight) {
      this.pendingOperation = { center: center.clone(), rotation, config, hash };
      return;
    }

    // No batch in flight — dispatch immediately
    this.dispatchPreviewBatch(operation, hash);
  }

  /**
   * Dispatch a preview batch to workers. Sets batchInFlight = true.
   * On completion, atomically applies meshes then checks for pending.
   */
  private dispatchPreviewBatch(operation: BuildOperation, hash: string): void {
    if (!this.world || !this.scene || !this.meshPool) return;

    // Get affected chunks
    const affectedKeys = getAffectedChunks(operation);

    // === Pass 1: Copy temp data and draw operation to ALL affected chunks ===
    // Must complete before grid expansion so boundary reads see drawn neighbors.
    const drawnChunks: string[] = [];
    const drawnSet = new Set<string>();

    for (const key of affectedKeys) {
      let chunk = this.world.chunks.get(key);
      if (!chunk) {
        // Chunk not loaded — create an empty one so the preview can render.
        const { cx, cy, cz } = parseChunkKey(key);
        chunk = new Chunk(cx, cy, cz);
        this.world.chunks.set(key, chunk);
      }

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

    // === Pass 2b: Include low-side neighbors whose margin reads drawn chunk data ===
    // The mesh grid has a +2 HIGH-side margin (positions 32-33). So only the
    // negative-direction neighbor (-X, -Y, -Z) reads from a drawn chunk's data.
    // We only add a neighbor if the drawn chunk actually has changes in the first
    // 2 voxel layers on that face (the margin the neighbor would sample).
    for (const key of drawnChunks) {
      const chunk = this.world.chunks.get(key)!;
      const data = chunk.data;
      const temp = chunk.tempData!;

      // Check low-X face (x=0..1) → neighbor at -X
      if (this.hasBoundaryChanges(data, temp, 'x')) {
        const nk = chunkKey(chunk.cx - 1, chunk.cy, chunk.cz);
        if (!newActiveChunks.has(nk)) {
          const neighbor = this.world.chunks.get(nk);
          if (neighbor) {
            const grid = this.meshPool.takeGrid();
            const skipHighBoundary = expandChunkToGrid(neighbor, this.world.chunks, grid, true);
            batchItems.push({ chunkKey: nk, grid, skipHighBoundary });
            newActiveChunks.add(nk);
          }
        }
      }

      // Check low-Y face (y=0..1) → neighbor at -Y
      if (this.hasBoundaryChanges(data, temp, 'y')) {
        const nk = chunkKey(chunk.cx, chunk.cy - 1, chunk.cz);
        if (!newActiveChunks.has(nk)) {
          const neighbor = this.world.chunks.get(nk);
          if (neighbor) {
            const grid = this.meshPool.takeGrid();
            const skipHighBoundary = expandChunkToGrid(neighbor, this.world.chunks, grid, true);
            batchItems.push({ chunkKey: nk, grid, skipHighBoundary });
            newActiveChunks.add(nk);
          }
        }
      }

      // Check low-Z face (z=0..1) → neighbor at -Z
      if (this.hasBoundaryChanges(data, temp, 'z')) {
        const nk = chunkKey(chunk.cx, chunk.cy, chunk.cz - 1);
        if (!newActiveChunks.has(nk)) {
          const neighbor = this.world.chunks.get(nk);
          if (neighbor) {
            const grid = this.meshPool.takeGrid();
            const skipHighBoundary = expandChunkToGrid(neighbor, this.world.chunks, grid, true);
            batchItems.push({ chunkKey: nk, grid, skipHighBoundary });
            newActiveChunks.add(nk);
          }
        }
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
      this.renderedHash = hash;
      return;
    }

    // Mark in flight
    this.batchInFlight = true;
    this.renderedHash = hash;

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

    const { rotation, config, hash } = this.pendingOperation;
    const center = this.pendingOperation.center;
    this.pendingOperation = null;

    // Skip if the pending hash matches what we just rendered
    if (hash === this.renderedHash) return;

    const operation = this.createOperation(center, rotation, config);
    this.currentOperation = operation;
    this.dispatchPreviewBatch(operation, hash);
  }

  /**
   * Clear all preview state (e.g., when player switches to non-build tool).
   */
  clearPreview(): void {
    if (!this.world || !this.scene) return;

    // Cancel in-flight batch (truly cancel — we're done with preview)
    if (this.cancelBatch) {
      this.cancelBatch();
      this.cancelBatch = null;
    }
    this.batchInFlight = false;
    this.pendingOperation = null;

    for (const key of this.activePreviewChunks) {
      this.clearChunkPreview(key);
    }

    this.activePreviewChunks.clear();
    this.renderedHash = '';
    this.currentOperation = null;
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

    // Cancel in-flight batch
    if (this.cancelBatch) {
      this.cancelBatch();
      this.cancelBatch = null;
    }
    this.batchInFlight = false;
    this.pendingOperation = null;

    // Discard temp data but KEEP preview meshes visible
    for (const key of this.activePreviewChunks) {
      const chunk = this.world.chunks.get(key);
      if (chunk) {
        chunk.discardTemp();
      }
      this.pendingCommitChunks.add(key);
    }

    // Clear preview state (but pendingCommitChunks stays until remesh completes)
    this.activePreviewChunks.clear();
    this.renderedHash = '';
    this.currentOperation = null;
  }

  /**
   * Commit the current preview to actual voxel data.
   * Call this when the player clicks to place.
   * Delegates to VoxelWorld.applyBuildOperation for DRY.
   * 
   * @returns Array of chunk keys that need collision rebuild (modified + neighbors)
   */
  commitPreview(): string[] {
    if (!this.world || !this.scene || !this.currentOperation) return [];

    // Cancel in-flight batch
    if (this.cancelBatch) {
      this.cancelBatch();
      this.cancelBatch = null;
    }
    this.batchInFlight = false;
    this.pendingOperation = null;

    // Discard temp data but KEEP preview meshes visible — they'll be cleared
    // when the remesh results arrive (prevents flicker gap).
    for (const key of this.activePreviewChunks) {
      const chunk = this.world.chunks.get(key);
      if (chunk) {
        chunk.discardTemp();
      }
      this.pendingCommitChunks.add(key);
    }

    // Apply the operation using the shared VoxelWorld method (DRY)
    const modifiedKeys = this.world.applyBuildOperation(this.currentOperation);

    // Clear preview state (but pendingCommitChunks stays until remesh completes)
    this.activePreviewChunks.clear();
    this.renderedHash = '';
    this.currentOperation = null;

    return modifiedKeys;
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
   * Create a hash string for operation change detection.
   */
  private hashOperation(operation: BuildOperation): string {
    const c = operation.center;
    const r = operation.rotation;
    const cfg = operation.config;
    const px = Math.round(c.x * 100);
    const py = Math.round(c.y * 100);
    const pz = Math.round(c.z * 100);
    return `${px},${py},${pz}|${r.y.toFixed(3)}|${cfg.shape}|${cfg.mode}|${cfg.size.x},${cfg.size.y},${cfg.size.z}|${cfg.material}`;
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
   * Check if the first 2 voxel layers on the low side of an axis differ
   * between original data and tempData. The mesh grid's +2 high-side margin
   * means only the negative-direction neighbor reads from these layers.
   * 
   * Returns true as soon as any difference is found (early-exit).
   */
  private hasBoundaryChanges(
    data: Uint16Array,
    temp: Uint16Array,
    axis: 'x' | 'y' | 'z',
  ): boolean {
    const CS = CHUNK_SIZE;
    // Check the first 2 layers (0 and 1) on the given axis
    for (let layer = 0; layer < 2; layer++) {
      for (let a = 0; a < CS; a++) {
        for (let b = 0; b < CS; b++) {
          let idx: number;
          if (axis === 'x') {
            idx = voxelIndex(layer, a, b);      // x=0..1, y=a, z=b
          } else if (axis === 'y') {
            idx = voxelIndex(a, layer, b);      // x=a, y=0..1, z=b
          } else {
            idx = voxelIndex(a, b, layer);      // x=a, y=b, z=0..1
          }
          if (data[idx] !== temp[idx]) return true;
        }
      }
    }
    return false;
  }
}
