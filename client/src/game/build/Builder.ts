/**
 * Builder - Coordinates the voxel build system
 * 
 * Responsibilities:
 * - Owns BuildMarker instance
 * - Owns BuildPreview instance for voxel preview rendering
 * - Updates marker each frame with raycast
 * - Handles place action (sends to server)
 * - Reads state from bridge, doesn't duplicate it
 */

import * as THREE from 'three';
import { BuildMarker } from './BuildMarker';
import { BuildPreview } from './BuildPreview';
import { storeBridge } from '../../state/bridge';
import { Controls } from '../player/controls';
import { VoxelWorld } from '../voxel/VoxelWorld.js';
import { sendBinary } from '../../net/netClient';
import { encodeVoxelBuildIntent, VoxelBuildIntent, yRotationQuat } from '@worldify/shared';

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

  /** Injected controls instance */
  private readonly controls: Controls;

  constructor(controls: Controls) {
    this.controls = controls;
    this.marker = new BuildMarker();
    this.preview = new BuildPreview();

    // Register for build place events from controls
    this.controls.onBuildPlace = this.handlePlace;
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
    this.preview.initialize(world, scene, world.meshPool);

    // When a chunk remesh completes, let preview clear committed preview meshes.
    // Chain onto existing onChunkRemeshed (VoxelIntegration sets up collision rebuild).
    const existingCallback = world.onChunkRemeshed;
    world.onChunkRemeshed = (chunkKey) => {
      existingCallback?.(chunkKey);
      this.preview.onChunkRemeshed(chunkKey);
    };
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

    // Create build intent using shared rotation helper
    const intent: VoxelBuildIntent = {
      center: { x: targetPos.x, y: targetPos.y, z: targetPos.z },
      rotation: yRotationQuat(rotationRadians),
      config: preset.config,
    };

    // Send build intent to server
    const encoded = encodeVoxelBuildIntent(intent);
    sendBinary(encoded);

    // Note: We no longer apply locally - server will broadcast commit and we apply from that
    // This ensures all clients stay in sync. Clear preview since we're waiting for server.
    this.preview.clearPreview();
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
    // Only clear callback if it's still ours
    if (this.controls.onBuildPlace === this.handlePlace) {
      this.controls.onBuildPlace = null;
    }
    this.marker.dispose();
    this.preview.dispose();
  }
}
