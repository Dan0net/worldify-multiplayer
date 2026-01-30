/**
 * BuildPreview - Coordinates voxel preview rendering for the build system
 * 
 * When the player aims at terrain with a build tool selected, this class:
 * 1. Copies affected chunk data to tempData buffers
 * 2. Draws the build operation to tempData (non-destructive preview)
 * 3. Generates preview meshes from tempData
 * 4. Manages cleanup when preview ends or position changes
 */

import * as THREE from 'three';
import {
  BuildOperation,
  BuildConfig,
  drawToChunk,
  getAffectedChunks,
  yRotationQuat,
} from '@worldify/shared';
import { VoxelWorld } from '../voxel/VoxelWorld.js';
import { meshChunk } from '../voxel/ChunkMesher.js';

/**
 * BuildPreview manages non-destructive voxel preview rendering.
 */
export class BuildPreview {
  /** The voxel world to preview in */
  private world: VoxelWorld | null = null;

  /** Scene for adding/removing preview meshes */
  private scene: THREE.Scene | null = null;

  /** Set of chunk keys currently showing preview */
  private activePreviewChunks: Set<string> = new Set();

  /** Last operation that was previewed (for change detection and commit) */
  private lastOperationHash: string = '';

  /** The current preview operation (stored for commitPreview) */
  private currentOperation: BuildOperation | null = null;

  /**
   * Set the voxel world and scene to use for preview.
   */
  initialize(world: VoxelWorld, scene: THREE.Scene): void {
    this.world = world;
    this.scene = scene;
  }

  /**
   * Update the preview for a build operation at the given position.
   * Call this every frame when the player is aiming with a build tool.
   * 
   * @param center World position center of the build
   * @param rotationRadians Y-axis rotation in radians
   * @param config Build configuration
   */
  updatePreview(
    center: THREE.Vector3,
    rotationRadians: number,
    config: BuildConfig
  ): void {
    if (!this.world || !this.scene) return;

    // Create build operation
    const operation = this.createOperation(center, rotationRadians, config);

    // Check if operation changed (avoid redundant work)
    const hash = this.hashOperation(operation);
    if (hash === this.lastOperationHash && this.activePreviewChunks.size > 0) {
      return; // No change
    }
    this.lastOperationHash = hash;

    // Get affected chunks
    const affectedKeys = getAffectedChunks(operation);

    // Clear preview for chunks no longer affected
    for (const key of this.activePreviewChunks) {
      if (!affectedKeys.includes(key)) {
        this.clearChunkPreview(key);
      }
    }

    // Store current operation for potential commit
    this.currentOperation = operation;

    // Update active set
    const newActiveChunks = new Set<string>();
    const modifiedKeys: string[] = [];

    // For each affected chunk, update tempData and draw operation
    for (const key of affectedKeys) {
      const chunk = this.world.chunks.get(key);
      if (!chunk) continue;

      // Initialize temp data from current data
      chunk.copyToTemp();
      
      // Draw operation to this chunk's tempData
      if (chunk.tempData) {
        const changed = drawToChunk(chunk, operation, chunk.tempData);
        if (changed) {
          modifiedKeys.push(key);
        }
      }

      newActiveChunks.add(key);
    }

    // Generate preview meshes for affected chunks
    for (const key of newActiveChunks) {
      const chunk = this.world.chunks.get(key);
      if (!chunk) continue;

      const chunkMesh = this.world.meshes.get(key);
      if (!chunkMesh) continue;

      // Only update preview if this chunk was actually modified
      if (!modifiedKeys.includes(key)) continue;

      // Generate mesh from tempData
      const output = meshChunk(chunk, this.world.chunks, true);

      // Update preview mesh
      chunkMesh.updatePreviewMesh(output, this.scene);
      chunkMesh.setPreviewActive(true, this.scene);
    }

    this.activePreviewChunks = newActiveChunks;
  }

  /**
   * Clear all preview state (e.g., when player switches to non-build tool).
   */
  clearPreview(): void {
    if (!this.world || !this.scene) return;

    for (const key of this.activePreviewChunks) {
      this.clearChunkPreview(key);
    }

    this.activePreviewChunks.clear();
    this.lastOperationHash = '';
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
   * Commit the current preview to actual voxel data.
   * Call this when the player clicks to place.
   * Delegates to VoxelWorld.applyBuildOperation for DRY.
   * 
   * @returns Array of chunk keys that need collision rebuild (modified + neighbors)
   */
  commitPreview(): string[] {
    if (!this.world || !this.scene || !this.currentOperation) return [];

    // Clear preview meshes first
    for (const key of this.activePreviewChunks) {
      const chunk = this.world.chunks.get(key);
      if (chunk) {
        chunk.discardTemp();
      }

      const chunkMesh = this.world.meshes.get(key);
      if (chunkMesh) {
        chunkMesh.setPreviewActive(false, this.scene);
      }
    }

    // Apply the operation using the shared VoxelWorld method (DRY)
    const modifiedKeys = this.world.applyBuildOperation(this.currentOperation);

    // Clear preview state
    this.activePreviewChunks.clear();
    this.lastOperationHash = '';
    this.currentOperation = null;

    return modifiedKeys;
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
    rotationRadians: number,
    config: BuildConfig
  ): BuildOperation {
    return {
      center: { x: center.x, y: center.y, z: center.z },
      rotation: yRotationQuat(rotationRadians),
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
    // Round position to avoid float precision issues
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
  }
}
