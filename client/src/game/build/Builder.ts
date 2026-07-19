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
import { useGameStore } from '../../state/store';
import { triggerArmSwing } from '../scene/FirstPersonArm';
import { getBuildPreset, getBuildIsEnabled } from '../../state/buildAccessors';
import { Controls } from '../player/controls';
import { VoxelWorld } from '../voxel/VoxelWorld.js';
import { sendBinary } from '../../net/netClient';
import { encodeVoxelBuildIntent, VoxelBuildIntent, BuildMode, BuildPresetSnapShape, PLAYER_HEIGHT, PLAYER_RADIUS, VOXEL_SCALE, MAX_BUILD_DISTANCE, isTransparent, punchParts, worldToVoxel, voxelToWorld } from '@worldify/shared';

/** Identity quaternion for un-rotated ops (e.g. the punch sphere). */
const IDENTITY_QUAT = { x: 0, y: 0, z: 0, w: 1 };

/**
 * Material id of the terrain mesh at a raycast hit, read from the nearest face vertex. The terrain
 * geometry carries per-vertex `materialIds` (3) + `materialWeights` (3); each vertex's own dominant
 * material is the `materialIds` component whose `materialWeights` component is largest. Returns -1
 * if the hit geometry has no material attribute.
 */
function materialAtHit(hit: THREE.Intersection): number {
  const face = hit.face;
  const geom = (hit.object as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
  if (!face || !geom) return -1;
  const ids = geom.getAttribute('materialIds');
  const wts = geom.getAttribute('materialWeights');
  const pos = geom.getAttribute('position');
  if (!ids || !wts || !pos) return -1;

  // Pick the face vertex nearest the hit point (in world space).
  const vidx = [face.a, face.b, face.c];
  let best = vidx[0];
  let bestDist = Infinity;
  const p = new THREE.Vector3();
  for (const v of vidx) {
    p.fromBufferAttribute(pos, v).applyMatrix4(hit.object.matrixWorld);
    const d = p.distanceToSquared(hit.point);
    if (d < bestDist) { bestDist = d; best = v; }
  }

  // That vertex's own material = the id slot whose weight is max.
  const w = [wts.getX(best), wts.getY(best), wts.getZ(best)];
  const k = w[1] > w[0] ? (w[2] > w[1] ? 2 : 1) : (w[2] > w[0] ? 2 : 0);
  return Math.round([ids.getX(best), ids.getY(best), ids.getZ(best)][k]);
}

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

  /** Injected controls instance */
  private readonly controls: Controls;

  /** Latest camera + reusable raycaster for the punch (works outside build mode). */
  private lastCamera: THREE.Camera | null = null;
  private readonly punchRaycaster = new THREE.Raycaster();

  /**
   * Called after a build is applied locally (offline mode) with the modified
   * chunk keys, so the host can refresh map tiles. Set by GameCore.
   */
  public onBuildApplied: ((modifiedChunkKeys: string[]) => void) | null = null;

  constructor(controls: Controls) {
    this.controls = controls;
    this.marker = new BuildMarker();
    this.preview = new BuildPreview();
    this.snapManager = new SnapManager();

    // Register for build place + punch events from controls
    this.controls.onBuildPlace = this.handlePlace;
    this.controls.onPunch = this.handlePunch;
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

  /** Snap manager (for snap-point persistence wiring). */
  getSnapManager(): SnapManager {
    return this.snapManager;
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
    // Remember the camera so the punch (which fires outside build mode, when the marker is hidden)
    // can raycast on demand.
    this.lastCamera = camera;

    // Skip if no mesh provider
    if (!this.meshProvider) return;

    // Sync snap state from bridge
    // Only enable point snaps when snapping is toggled on AND the active preset supports snaps
    const presetHasSnaps = getBuildIsEnabled()
      && getBuildPreset().snapShape !== BuildPresetSnapShape.NONE;
    this.snapManager.snapPointEnabled = useGameStore.getState().build.snapPoint && presetHasSnaps;
    this.snapManager.gridSnapEnabled = useGameStore.getState().build.snapGrid;

    // Get collision meshes for raycasting
    const meshes = this.meshProvider.getCollisionMeshes();

    // Update the marker and get valid target state.
    // On mobile, controls.castNDC positions the ray at the draggable reticle;
    // on desktop it is null and the marker uses the camera-centre ray.
    let { hasValidTarget } = this.marker.update(camera, meshes, this.controls.castNDC);
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
        const preset = getBuildPreset();
        const rotation = this.marker.getPlacementRotation();
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
      const preset = getBuildPreset();
      const mode = preset.parts[0].config.mode;
      const materialIsTransparent = isTransparent(preset.parts[0].config.material);
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
        const preset = getBuildPreset();
        const rotation = this.marker.getPlacementRotation();
        this.snapManager.updateVisuals(
          preset,
          { x: finalPos.x, y: finalPos.y, z: finalPos.z },
          rotation,
          snappedDepositedIndices,
          snappedCurrentIndices,
        );
      }
    } else if (this.snapManager.snapPointEnabled) {
      this.snapManager.updateVisuals(getBuildPreset(), { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, EMPTY_SET, EMPTY_SET);
    }

    // Fade snap markers based on distance from camera
    if (this.snapManager.snapPointEnabled) {
      this.snapManager.updateFade(camera.position as THREE.Vector3);
    }

    // Update store with valid target state and reason
    useGameStore.getState().setBuildHasValidTarget(hasValidTarget);
    useGameStore.getState().setBuildInvalidReason(invalidReason);

    // Check if deferred preview can now be shown (pending group merges resolved)
    this.preview.finalizeDeferredPreview();

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
    // Skip if preview disabled or not initialized. If a preview is still on screen (e.g. previewEnabled
    // just toggled off, or a held post-commit preview), clear it so stale preview meshes don't linger.
    if (!this.previewEnabled || !this.voxelWorld || !this.scene) {
      if (this.voxelWorld && this.scene && this.preview.hasVisiblePreview()) this.preview.clearPreview();
      return;
    }

    // Skip if build mode disabled
    if (!getBuildIsEnabled()) {
      this.preview.clearPreview();
      return;
    }

    // Skip if no valid target
    if (!useGameStore.getState().build.hasValidTarget) {
      this.preview.clearPreview();
      return;
    }

    // Get target position from marker
    const targetPos = this.marker.getTargetPosition();
    if (!targetPos) {
      this.preview.clearPreview();
      return;
    }

    // Get preset and the full placement rotation (point-out uses the face normal)
    const preset = getBuildPreset();
    const rotation = this.marker.getPlacementRotation();
    this.preview.updatePreview(targetPos, rotation, preset.parts);
  }

  /**
   * Handle place action from controls.
   */
  private handlePlace = (): void => {
    // Skip if build mode disabled
    if (!getBuildIsEnabled()) return;

    // Skip if no valid target
    if (!useGameStore.getState().build.hasValidTarget) return;

    const targetPos = this.marker.getTargetPosition();
    if (!targetPos) return;

    // Swing the first-person arm — build dips the hand down.
    triggerArmSwing('build');

    const preset = getBuildPreset();

    // Full placement rotation (point-out orients out of the targeted face); the preset's
    // parts (e.g. torch = column + lava tip) travel in a single atomic operation.
    const rotation = this.marker.getPlacementRotation();
    const parts = preset.parts;
    const center = { x: targetPos.x, y: targetPos.y, z: targetPos.z };

    const intent: VoxelBuildIntent = {
      center,
      rotation,
      parts,
    };

    if (useGameStore.getState().useServerChunks) {
      // Multiplayer: send intent; server validates and broadcasts a commit that
      // every client (including us) applies via GameCore.handleBuildCommit.
      const encoded = encodeVoxelBuildIntent(intent);
      sendBinary(encoded);
    } else {
      // Offline: no server round-trip — apply directly to the local world.
      const operation = { center, rotation, parts };
      const modified = this.voxelWorld?.applyBuildOperation(operation) ?? [];
      if (modified.length > 0) {
        this.onBuildApplied?.(modified);
      }
    }

    // Deposit snap points at the placed position
    this.snapManager.deposit(preset, center, rotation);

    // Hold preview visible until the (server- or locally-) triggered remesh completes.
    this.preview.holdPreview();
  };

  /**
   * Handle the left-click / tap "punch": material-filtered dig. Raycasts from the camera (or the
   * mobile reticle) to the surface, samples the material of the voxel just inside it, and carves a
   * radius-2 blob of ONLY that material (grass digs grass, not the brick next to it). The selected
   * hotbar item is irrelevant here — the match material comes from the hit voxel.
   */
  private handlePunch = (): void => {
    const camera = this.lastCamera;
    if (!camera || !this.meshProvider || !this.voxelWorld) return;

    // Raycast: mobile uses the reticle NDC, desktop the camera-centre ray (mirrors BuildMarker).
    const castNDC = this.controls.castNDC;
    if (castNDC) {
      this.punchRaycaster.setFromCamera(new THREE.Vector2(castNDC.x, castNDC.y), camera);
    } else {
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      this.punchRaycaster.set(camera.position, dir);
    }
    this.punchRaycaster.far = MAX_BUILD_DISTANCE;

    const hits = this.punchRaycaster.intersectObjects(this.meshProvider.getCollisionMeshes(), false);
    const hit = hits[0];
    if (!hit || !hit.face) return;

    // Material = the material of the mesh vertex we actually clicked (reliable: a mesh hit is always
    // a real surface). Reading the nearest voxel instead can land in air / the wrong material.
    const material = materialAtHit(hit);
    if (material < 0) return; // hit geometry had no material attribute — nothing to punch

    // Centre the punch sphere on the voxel just inside the surface (along -normal).
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    const px = hit.point.x - n.x * VOXEL_SCALE * 0.5;
    const py = hit.point.y - n.y * VOXEL_SCALE * 0.5;
    const pz = hit.point.z - n.z * VOXEL_SCALE * 0.5;
    const { vx, vy, vz } = worldToVoxel(px, py, pz);
    const center = voxelToWorld(vx, vy, vz);
    const parts = punchParts(material);

    triggerArmSwing('punch');

    if (useGameStore.getState().useServerChunks) {
      sendBinary(encodeVoxelBuildIntent({ center, rotation: IDENTITY_QUAT, parts }));
    } else {
      const modified = this.voxelWorld.applyBuildOperation({ center, rotation: IDENTITY_QUAT, parts }) ?? [];
      if (modified.length > 0) this.onBuildApplied?.(modified);
    }
  };

  /**
   * Hand the current build preview off as a commit: moves the previewed chunks into the
   * pending-commit set so the next remesh clears the stale preview mesh and restores the
   * (preview-suppressed) group. Used by undo — it mutates voxels + dispatches a remesh but,
   * unlike a place, otherwise never notifies the preview system, so the reverted chunk would
   * stay hidden behind the old preview mesh. No-op when no preview is active.
   */
  commitPreview(): void {
    this.preview.holdPreview();
  }

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
    // Only clear callbacks if they're still ours
    if (this.controls.onBuildPlace === this.handlePlace) {
      this.controls.onBuildPlace = null;
    }
    if (this.controls.onPunch === this.handlePunch) {
      this.controls.onPunch = null;
    }
    this.marker.dispose();
    this.preview.dispose();
    this.snapManager.dispose();
  }
}
