/**
 * Builder - Coordinates the voxel build system
 * 
 * Responsibilities:
 * - Owns BuildMarker instance
 * - Updates marker each frame with raycast
 * - Handles place action (future: sends to server)
 * - Reads state from bridge, doesn't duplicate it
 */

import * as THREE from 'three';
import { BuildMarker } from './BuildMarker';
import { storeBridge } from '../../state/bridge';
import { controls } from '../player/controls';

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

  /** Provider for collision meshes */
  private meshProvider: CollisionMeshProvider | null = null;

  /** Whether the builder has been added to a scene */
  private addedToScene = false;

  constructor() {
    this.marker = new BuildMarker();

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
   * Add the builder's visual elements to the scene.
   */
  addToScene(scene: THREE.Scene): void {
    if (this.addedToScene) return;
    scene.add(this.marker.getObject());
    this.addedToScene = true;
  }

  /**
   * Remove the builder's visual elements from the scene.
   */
  removeFromScene(scene: THREE.Scene): void {
    if (!this.addedToScene) return;
    scene.remove(this.marker.getObject());
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

    // Update the marker
    this.marker.update(camera, meshes);
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

    // TODO: Send build intent to server
    // For now, just log the build action
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

    // TODO: Optimistic apply to local voxel world
    // TODO: Network message to server
  };

  /**
   * Get the build marker.
   */
  getMarker(): BuildMarker {
    return this.marker;
  }

  /**
   * Dispose of resources.
   */
  dispose(): void {
    controls.onBuildPlace = null;
    this.marker.dispose();
  }
}
