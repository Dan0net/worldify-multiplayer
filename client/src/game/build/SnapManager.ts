/**
 * SnapManager — Coordinates snap point detection, storage, and visualization.
 * 
 * Owns the deposited snap points and the BuildSnapMarker visuals.
 * Called by Builder each frame to:
 *   1. Detect the closest deposited↔current snap pair (trySnap)
 *   2. Apply the snap delta to move the build center
 *   3. Update visual markers at the post-snap position (updateVisuals)
 * 
 * On placement, deposits the current shape's world-space snap points.
 */

import * as THREE from 'three';
import { BuildSnapMarker } from './BuildSnapMarker';
import {
  BuildPreset,
  BuildPresetSnapShape,
  generateSnapPointsLocal,
  snapPointsToWorld,
  SNAP_DISTANCE_MAX,
  SNAP_MARKER_COUNT_MAX,
} from '@worldify/shared';
import type { Vec3, Quat } from '@worldify/shared';

/**
 * Result of a snap attempt.
 */
export interface SnapResult {
  /** Whether a snap connection was found */
  snapped: boolean;
  /** Delta to apply to the build center (world units). Zero if not snapped. */
  delta: THREE.Vector3;
  /** Index of the deposited marker that was snapped to (-1 if none) */
  snappedDepositedIndex: number;
}

const NO_SNAP: SnapResult = {
  snapped: false,
  delta: new THREE.Vector3(),
  snappedDepositedIndex: -1,
};

/**
 * SnapManager manages snap point detection and deposited marker storage.
 */
export class SnapManager {
  /** Visual marker renderer */
  private readonly marker: BuildSnapMarker;

  /** Deposited snap points in world space (FIFO ring buffer) */
  private depositedPoints: THREE.Vector3[] = [];

  /** Whether snap point mode is enabled */
  private _snapPointEnabled = false;

  /** Whether grid snap mode is enabled */
  private _gridSnapEnabled = false;

  /** Cached local snap points for current preset */
  private cachedLocalPoints: Vec3[] = [];
  private cachedPresetId = -1;

  /** Temp vectors for computation */
  private readonly _tempCurrent = new THREE.Vector3();
  private readonly _tempDelta = new THREE.Vector3();

  constructor() {
    this.marker = new BuildSnapMarker();
  }

  /**
   * Get the Three.js group to add to the scene.
   */
  getObject(): THREE.Group {
    return this.marker.group;
  }

  /**
   * Whether point snap is enabled.
   */
  get snapPointEnabled(): boolean {
    return this._snapPointEnabled;
  }

  set snapPointEnabled(value: boolean) {
    this._snapPointEnabled = value;
    this.marker.setVisible(value);
  }

  /**
   * Whether grid snap is enabled.
   */
  get gridSnapEnabled(): boolean {
    return this._gridSnapEnabled;
  }

  set gridSnapEnabled(value: boolean) {
    this._gridSnapEnabled = value;
  }

  /**
   * Toggle point snap on/off.
   */
  toggleSnapPoint(): void {
    this.snapPointEnabled = !this._snapPointEnabled;
  }

  /**
   * Toggle grid snap on/off.
   */
  toggleGridSnap(): void {
    this.gridSnapEnabled = !this._gridSnapEnabled;
  }

  /**
   * Apply grid snapping to a position (mutates in place).
   * Quantizes to the nearest voxel grid position.
   * 
   * @param position Position to snap (mutated)
   * @param voxelScale Voxel scale in meters
   */
  applyGridSnap(position: THREE.Vector3, voxelScale: number): void {
    if (!this._gridSnapEnabled) return;
    position.x = Math.round(position.x / voxelScale) * voxelScale;
    position.y = Math.round(position.y / voxelScale) * voxelScale;
    position.z = Math.round(position.z / voxelScale) * voxelScale;
  }

  /**
   * Detect snap: find the closest deposited↔current pair.
   * Does NOT update visuals — call updateVisuals() after applying the delta.
   * 
   * @param preset Current build preset
   * @param center Current build center position (world space)
   * @param rotation Current composed rotation quaternion
   * @returns SnapResult with delta to apply
   */
  trySnap(preset: BuildPreset, center: Vec3, rotation: Quat): SnapResult {
    if (!this._snapPointEnabled || preset.snapShape === BuildPresetSnapShape.NONE) {
      return NO_SNAP;
    }

    // Get local snap points (cached per preset)
    const localPoints = this.getLocalPoints(preset);
    if (localPoints.length === 0) {
      return NO_SNAP;
    }

    // Transform to world space at current (pre-snap) position
    const worldPoints = snapPointsToWorld(localPoints, center, rotation);

    // Find closest pair: current snap point ↔ deposited marker
    if (this.depositedPoints.length === 0) {
      return NO_SNAP;
    }

    let minDist = SNAP_DISTANCE_MAX;
    let bestDelta: THREE.Vector3 | null = null;
    let bestDepositedIndex = -1;

    for (const wp of worldPoints) {
      this._tempCurrent.set(wp.x, wp.y, wp.z);

      for (let di = 0; di < this.depositedPoints.length; di++) {
        const d = this._tempCurrent.distanceTo(this.depositedPoints[di]);
        if (d < minDist) {
          minDist = d;
          bestDelta = this._tempDelta.clone().subVectors(this._tempCurrent, this.depositedPoints[di]);
          bestDepositedIndex = di;
        }
      }
    }

    if (bestDelta) {
      return { snapped: true, delta: bestDelta, snappedDepositedIndex: bestDepositedIndex };
    }

    return NO_SNAP;
  }

  /**
   * Update visual markers at the post-snap (final) build position.
   * Call this AFTER applying snap delta so markers appear at the correct spot.
   * 
   * @param preset Current build preset
   * @param center Build center AFTER snap offset (world space)
   * @param rotation Composed rotation quaternion
   * @param snappedDepositedIndex Index of snapped deposited marker (-1 if none)
   */
  updateVisuals(preset: BuildPreset, center: Vec3, rotation: Quat, snappedDepositedIndex: number): void {
    if (!this._snapPointEnabled || preset.snapShape === BuildPresetSnapShape.NONE) {
      this.marker.updateCurrent([]);
      this.marker.setSnappedIndex(-1);
      return;
    }

    const localPoints = this.getLocalPoints(preset);
    if (localPoints.length === 0) {
      this.marker.updateCurrent([]);
      this.marker.setSnappedIndex(-1);
      return;
    }

    // Transform to world space at the FINAL (post-snap) position
    const worldPoints = snapPointsToWorld(localPoints, center, rotation);
    const currentPositions = worldPoints.map(p => new THREE.Vector3(p.x, p.y, p.z));
    this.marker.updateCurrent(currentPositions);

    // Highlight the specific deposited marker being snapped to
    this.marker.setSnappedIndex(snappedDepositedIndex);
  }

  /**
   * Deposit snap points for the current build position.
   * Called after a successful placement.
   * 
   * @param preset Current build preset
   * @param center Build center position (world space, after snap)
   * @param rotation Current composed rotation quaternion
   */
  deposit(preset: BuildPreset, center: Vec3, rotation: Quat): void {
    if (!this._snapPointEnabled || preset.snapShape === BuildPresetSnapShape.NONE) return;

    const localPoints = this.getLocalPoints(preset);
    const worldPoints = snapPointsToWorld(localPoints, center, rotation);

    for (const wp of worldPoints) {
      // Deduplicate: skip if very close to an existing deposited point
      const newPos = new THREE.Vector3(wp.x, wp.y, wp.z);
      const isDuplicate = this.depositedPoints.some(
        dp => dp.distanceTo(newPos) < 0.01
      );
      if (!isDuplicate) {
        this.depositedPoints.push(newPos);
      }
    }

    // FIFO eviction
    while (this.depositedPoints.length > SNAP_MARKER_COUNT_MAX) {
      this.depositedPoints.shift();
    }

    // Update visual markers
    this.marker.updateDeposited(this.depositedPoints);
  }

  /**
   * Clear all deposited markers.
   */
  clearDeposited(): void {
    this.depositedPoints.length = 0;
    this.marker.updateDeposited([]);
  }

  /**
   * Get cached local snap points for a preset.
   */
  private getLocalPoints(preset: BuildPreset): Vec3[] {
    if (preset.id !== this.cachedPresetId) {
      this.cachedLocalPoints = generateSnapPointsLocal(preset.snapShape, preset.config.size);
      this.cachedPresetId = preset.id;
    }
    return this.cachedLocalPoints;
  }

  /**
   * Dispose of GPU resources.
   */
  dispose(): void {
    this.marker.dispose();
  }
}
