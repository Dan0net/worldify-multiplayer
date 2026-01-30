/**
 * Builder - Coordinates the voxel build system
 * 
 * Responsibilities:
 * - Owns BuildMarker instance
 * - Owns BuildPreview instance for voxel preview rendering
 * - Updates marker each frame with raycast
 * - Handles place action (future: sends to server)
 * - Reads state from bridge, doesn't duplicate it
 */

import * as THREE from 'three';
import { BuildMarker } from './BuildMarker';
import { BuildPreview } from './BuildPreview';
import { storeBridge } from '../../state/bridge';
import { controls } from '../player/controls';
import { VoxelWorld } from '../voxel/VoxelWorld.js';

/**
 * Interface for objects that provide collision meshes for raycasting.
 */
export interface CollisionMeshProvider {
  /** Get all meshes for raycasting */
  getCollisionMeshes(): THREE.Object3D[];
}

/**
 * Builder coordinates the build system.
 */
export class Builder {
  /** The build marker (wireframe indicator) */
  private readonly marker: BuildMarker;

  /** The build preview (voxel preview rendering) */
  private readonly preview: BuildPreview;

  /** Provider for collision meshes */
  private meshProvider: CollisionMeshProvider | null = null;

  /** Reference to voxel world for preview */
  private voxelWorld: VoxelWorld | null = null;

  /** Reference to scene */
  private scene: THREE.Scene | null = null;

  /** Whether the builder has been added to a scene */
  private addedToScene = false;

  /** Whether voxel preview is enabled */
  private previewEnabled: boolean = true;

  /** Callback when a build is committed (for collision rebuild) */
  onBuildCommit: ((modifiedChunks: string[]) => void) | null = null;

  constructor() {
    this.marker = new BuildMarker();
    this.preview = new BuildPreview();

    // Register for build place events from controls
    controls.onBuildPlace = this.handlePlace;
  }

  /**
   * Set the collision mesh provider.
   * This is typically the VoxelWorld or VoxelIntegration.
   */
  setMeshProvider(provider: CollisionMeshProvider): void {
    this.meshProvider = provider;
  }

  /**
   * Set the voxel world for preview rendering.
   * Must be called before preview will work.
   */
  setVoxelWorld(world: VoxelWorld, scene: THREE.Scene): void {
    this.voxelWorld = world;
    this.scene = scene;
    this.preview.initialize(world, scene);
  }

  /**
   * Enable or disable voxel preview rendering.
   */
  setPreviewEnabled(enabled: boolean): void {
    this.previewEnabled = enabled;
    if (!enabled) {
      this.preview.clearPreview();
    }
  }

  /**
   * Add the builder's visual elements to the scene.
   */
  addToScene(scene: THREE.Scene): void {
    if (this.addedToScene) return;
    scene.add(this.marker.getObject());
    this.scene = scene;
    this.addedToScene = true;
  }

  /**
   * Remove the builder's visual elements from the scene.
   */
  removeFromScene(scene: THREE.Scene): void {
    if (!this.addedToScene) return;
    scene.remove(this.marker.getObject());
    this.preview.clearPreview();
    this.addedToScene = false;
  }

  /**
   * Update the builder each frame.
   * Should be called from the game loop when not spectating.
   * 
   * @param camera The camera to raycast from
   */
  update(camera: THREE.Camera): void {
    // Skip if no mesh provider
    if (!this.meshProvider) return;

    // Get collision meshes for raycasting
    const meshes = this.meshProvider.getCollisionMeshes();

    // Update the marker and get valid target state
    const { hasValidTarget } = this.marker.update(camera, meshes);
    
    // Update store with valid target state
    storeBridge.setBuildHasValidTarget(hasValidTarget);

    // Update voxel preview
    this.updateVoxelPreview();
  }

  /**
   * Update the voxel preview based on current build state.
   */
  private updateVoxelPreview(): void {
    // Skip if preview disabled or not initialized
    if (!this.previewEnabled || !this.voxelWorld || !this.scene) {
      return;
    }

    // Skip if build mode disabled
    if (!storeBridge.buildIsEnabled) {
      this.preview.clearPreview();
      return;
    }

    // Skip if no valid target
    if (!storeBridge.buildState.hasValidTarget) {
      this.preview.clearPreview();
      return;
    }

    // Get target position from marker
    const targetPos = this.marker.getTargetPosition();
    if (!targetPos) {
      this.preview.clearPreview();
      return;
    }

    // Get preset and rotation
    const preset = storeBridge.buildPreset;
    const rotationRadians = storeBridge.buildRotationRadians;

    // Update preview
    this.preview.updatePreview(targetPos, rotationRadians, preset.config);
  }

  /**
   * Handle place action from controls.
   */
  private handlePlace = (): void => {
    // Skip if build mode disabled
    if (!storeBridge.buildIsEnabled) return;

    // Skip if no valid target
    if (!storeBridge.buildState.hasValidTarget) return;

    const targetPos = this.marker.getTargetPosition();
    if (!targetPos) return;

    const preset = storeBridge.buildPreset;
    const rotationRadians = storeBridge.buildRotationRadians;

    // Commit the preview to actual voxel data (optimistic apply)
    let modifiedChunks: string[] = [];
    if (this.preview.hasActivePreview()) {
      modifiedChunks = this.preview.commitPreview();
      console.log('[Builder] Committed preview to', modifiedChunks.length, 'chunks');
      
      // Notify caller to rebuild collision
      if (this.onBuildCommit && modifiedChunks.length > 0) {
        this.onBuildCommit(modifiedChunks);
      }
    }

    // TODO: Send build intent to server
    console.log('[Builder] Place:', {
      presetId: preset.id,
      presetName: preset.name,
      position: { x: targetPos.x, y: targetPos.y, z: targetPos.z },
      rotationDegrees: storeBridge.buildRotationDegrees,
      rotationRadians,
      mode: preset.config.mode,
      shape: preset.config.shape,
      size: preset.config.size,
    });

    // TODO: Network message to server
  };

  /**
   * Get the build marker.
   */
  getMarker(): BuildMarker {
    return this.marker;
  }

  /**
   * Get the build preview.
   */
  getPreview(): BuildPreview {
    return this.preview;
  }

  /**
   * Dispose of resources.
   */
  dispose(): void {
    controls.onBuildPlace = null;
    this.marker.dispose();
    this.preview.dispose();
  }
}
