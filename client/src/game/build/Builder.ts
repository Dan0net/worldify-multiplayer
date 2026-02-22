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
import { SnapManager } from './SnapManager';
import { storeBridge } from '../../state/bridge';
import { Controls } from '../player/controls';
import { VoxelWorld } from '../voxel/VoxelWorld.js';
import { sendBinary } from '../../net/netClient';
import { encodeVoxelBuildIntent, VoxelBuildIntent, composeRotation, BuildMode, BuildPresetSnapShape, PLAYER_HEIGHT, PLAYER_RADIUS, VOXEL_SCALE, isTransparent } from '@worldify/shared';

const EMPTY_SET: ReadonlySet<number> = new Set();

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

  /** Snap point manager */
  private readonly snapManager: SnapManager;

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
    this.snapManager = new SnapManager();

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
    world.addRemeshListener((chunkKey) => {
      this.preview.onChunkRemeshed(chunkKey);
    });
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
    scene.add(this.snapManager.getObject());
    this.scene = scene;
    this.addedToScene = true;
  }

  /**
   * Remove the builder's visual elements from the scene.
   */
  removeFromScene(scene: THREE.Scene): void {
    if (!this.addedToScene) return;
    scene.remove(this.marker.getObject());
    scene.remove(this.snapManager.getObject());
    this.preview.clearPreview();
    this.addedToScene = false;
  }

  /**
   * Update the builder each frame.
   * Should be called from the game loop when not spectating.
   * 
   * @param camera The camera to raycast from
   * @param playerPosition The local player's position (eye level)
   */
  update(camera: THREE.Camera, playerPosition: THREE.Vector3): void {
    // Skip if no mesh provider
    if (!this.meshProvider) return;

    // Sync snap state from bridge
    // Only enable point snaps when snapping is toggled on AND the active preset supports snaps
    const presetHasSnaps = storeBridge.buildIsEnabled
      && storeBridge.buildPreset.snapShape !== BuildPresetSnapShape.NONE;
    this.snapManager.snapPointEnabled = storeBridge.buildSnapPoint && presetHasSnaps;
    this.snapManager.gridSnapEnabled = storeBridge.buildSnapGrid;

    // Get collision meshes for raycasting
    const meshes = this.meshProvider.getCollisionMeshes();

    // Update the marker and get valid target state
    let { hasValidTarget } = this.marker.update(camera, meshes);
    let invalidReason: 'tooClose' | null = null;

    // Apply grid snap to marker position (before overlap check)
    if (hasValidTarget && this.snapManager.gridSnapEnabled) {
      this.snapManager.applyGridSnap(this.marker.getObject().position, VOXEL_SCALE);
    }

    // Apply point snap
    let snappedDepositedIndices: ReadonlySet<number> = EMPTY_SET;
    let snappedCurrentIndices: ReadonlySet<number> = EMPTY_SET;
    if (hasValidTarget && this.snapManager.snapPointEnabled) {
      const targetPos = this.marker.getTargetPosition();
      if (targetPos) {
        const preset = storeBridge.buildPreset;
        const rotation = composeRotation(preset, this.marker.getEffectiveYRadians());
        const snapResult = this.snapManager.trySnap(
          preset,
          { x: targetPos.x, y: targetPos.y, z: targetPos.z },
          rotation,
        );
        if (snapResult.snapped) {
          this.marker.applySnapOffset(snapResult.delta);
          snappedDepositedIndices = snapResult.snappedDepositedIndices;
          snappedCurrentIndices = snapResult.snappedCurrentIndices;
        }
      }
    }

    // Check if build shape overlaps player or camera (for modes that add solid geometry)
    // Skip check for transparent materials (player won't collide with them)
    if (hasValidTarget) {
      const preset = storeBridge.buildPreset;
      const mode = preset.config.mode;
      const materialIsTransparent = isTransparent(preset.config.material);
      if ((mode === BuildMode.ADD || mode === BuildMode.FILL) && !materialIsTransparent) {
        const aabb = this.marker.getWorldAABB();
        if (aabb && this.buildOverlapsPlayer(aabb, playerPosition, camera.position)) {
          hasValidTarget = false;
          invalidReason = 'tooClose';
          this.marker.setTooCloseWarning(true);
        }
      }
    }

    // Update snap visuals AFTER snap offset and overlap check
    // Hide current-shape markers when target is invalid
    if (hasValidTarget && this.snapManager.snapPointEnabled) {
      const finalPos = this.marker.getTargetPosition();
      if (finalPos) {
        const preset = storeBridge.buildPreset;
        const rotation = composeRotation(preset, this.marker.getEffectiveYRadians());
        this.snapManager.updateVisuals(
          preset,
          { x: finalPos.x, y: finalPos.y, z: finalPos.z },
          rotation,
          snappedDepositedIndices,
          snappedCurrentIndices,
        );
      }
    } else if (this.snapManager.snapPointEnabled) {
      this.snapManager.updateVisuals(storeBridge.buildPreset, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, EMPTY_SET, EMPTY_SET);
    }

    // Fade snap markers based on distance from camera
    if (this.snapManager.snapPointEnabled) {
      this.snapManager.updateFade(camera.position as THREE.Vector3);
    }

    // Update store with valid target state and reason
    storeBridge.setBuildHasValidTarget(hasValidTarget);
    storeBridge.setBuildInvalidReason(invalidReason);

    // Update voxel preview
    this.updateVoxelPreview();
  }

  /**
   * Check if a build AABB overlaps the player capsule or camera position.
   * Player capsule is approximated as an AABB for speed.
   * Adds leeway at the feet (raises the check bottom) so players can
   * comfortably build floors underneath themselves.
   */
  private buildOverlapsPlayer(
    aabb: { min: THREE.Vector3; max: THREE.Vector3 },
    playerPos: THREE.Vector3,
    cameraPos: THREE.Vector3
  ): boolean {
    // Player capsule AABB: position is at eye level, feet at position.y - PLAYER_HEIGHT
    // Leeway: ignore the bottom 0.5m so floor builds under the feet are allowed
    const FEET_LEEWAY = 0.5;
    const playerMin = {
      x: playerPos.x - PLAYER_RADIUS,
      y: playerPos.y - PLAYER_HEIGHT + FEET_LEEWAY,
      z: playerPos.z - PLAYER_RADIUS,
    };
    const playerMax = {
      x: playerPos.x + PLAYER_RADIUS,
      y: playerPos.y,
      z: playerPos.z + PLAYER_RADIUS,
    };

    // AABB vs AABB overlap test (player capsule)
    const overlapsPlayer =
      aabb.min.x <= playerMax.x && aabb.max.x >= playerMin.x &&
      aabb.min.y <= playerMax.y && aabb.max.y >= playerMin.y &&
      aabb.min.z <= playerMax.z && aabb.max.z >= playerMin.z;

    if (overlapsPlayer) return true;

    // Point-in-AABB test (camera)
    const containsCamera =
      cameraPos.x >= aabb.min.x && cameraPos.x <= aabb.max.x &&
      cameraPos.y >= aabb.min.y && cameraPos.y <= aabb.max.y &&
      cameraPos.z >= aabb.min.z && cameraPos.z <= aabb.max.z;

    return containsCamera;
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
    const rotationRadians = this.marker.getEffectiveYRadians();

    // Update preview with composed rotation (base + user Y)
    const rotation = composeRotation(preset, rotationRadians);
    this.preview.updatePreview(targetPos, rotation, preset.config);
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
    const rotationRadians = this.marker.getEffectiveYRadians();

    // Create build intent using composed rotation (base + user Y)
    const rotation = composeRotation(preset, rotationRadians);
    const center = { x: targetPos.x, y: targetPos.y, z: targetPos.z };

    const intent: VoxelBuildIntent = {
      center,
      rotation,
      config: preset.config,
    };

    // Send build intent to server
    const encoded = encodeVoxelBuildIntent(intent);
    sendBinary(encoded);

    // Deposit snap points at the placed position
    this.snapManager.deposit(preset, center, rotation);

    // Note: We no longer apply locally - server will broadcast commit and we apply from that
    // This ensures all clients stay in sync. Hold preview visible until server-confirmed remesh.
    this.preview.holdPreview();
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
    this.snapManager.dispose();
  }
}
