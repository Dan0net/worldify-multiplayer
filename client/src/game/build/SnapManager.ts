/**
 * SnapManager — Coordinates snap point detection, storage, and visualization.
 * 
 * Owns the deposited snap points and the BuildSnapMarker visuals.
 * Uses a spatial hash map for efficient neighbor lookups.
 * Called by Builder each frame to:
 *   1. Detect the closest deposited↔current snap pair (trySnap)
 *   2. Collect ALL overlapping pairs for visual highlighting
 *   3. Apply the snap delta to move the build center
 *   4. Update visual markers at the post-snap position (updateVisuals)
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

// ─── Spatial Hash Map ────────────────────────────────────────────────

/** Cell size for the spatial hash — equal to snap distance so neighbors are within 1 cell radius */
const CELL_SIZE = SNAP_DISTANCE_MAX;
const INV_CELL_SIZE = 1 / CELL_SIZE;

/** Hash a cell coordinate triple to a string key */
function cellKey(cx: number, cy: number, cz: number): string {
  return `${cx},${cy},${cz}`;
}

/**
 * Lightweight spatial hash for deposited snap points.
 * Maps cell keys → arrays of deposited point indices.
 */
class SpatialHash {
  private cells = new Map<string, number[]>();

  /** Rebuild from a list of points. */
  rebuild(points: THREE.Vector3[]): void {
    this.cells.clear();
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const key = cellKey(
        Math.floor(p.x * INV_CELL_SIZE),
        Math.floor(p.y * INV_CELL_SIZE),
        Math.floor(p.z * INV_CELL_SIZE),
      );
      let bucket = this.cells.get(key);
      if (!bucket) {
        bucket = [];
        this.cells.set(key, bucket);
      }
      bucket.push(i);
    }
  }

  /**
   * Return all deposited point indices within the 3×3×3 neighborhood
   * of the cell containing `pos`.
   */
  queryNeighbors(pos: { x: number; y: number; z: number }): number[] {
    const cx = Math.floor(pos.x * INV_CELL_SIZE);
    const cy = Math.floor(pos.y * INV_CELL_SIZE);
    const cz = Math.floor(pos.z * INV_CELL_SIZE);
    const result: number[] = [];

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = this.cells.get(cellKey(cx + dx, cy + dy, cz + dz));
          if (bucket) {
            for (let i = 0; i < bucket.length; i++) {
              result.push(bucket[i]);
            }
          }
        }
      }
    }
    return result;
  }

  clear(): void {
    this.cells.clear();
  }
}

// ─── SnapResult ──────────────────────────────────────────────────────

/**
 * Result of a snap attempt.
 */
export interface SnapResult {
  /** Whether a snap connection was found */
  snapped: boolean;
  /** Delta to apply to the build center (world units). Zero if not snapped. */
  delta: THREE.Vector3;
  /** All deposited marker indices that overlap with a current-shape marker */
  snappedDepositedIndices: Set<number>;
  /** All current-shape marker indices that overlap with a deposited marker */
  snappedCurrentIndices: Set<number>;
}

const EMPTY_SET: ReadonlySet<number> = new Set();

const NO_SNAP: SnapResult = {
  snapped: false,
  delta: new THREE.Vector3(),
  snappedDepositedIndices: EMPTY_SET as Set<number>,
  snappedCurrentIndices: EMPTY_SET as Set<number>,
};

// ─── SnapManager ─────────────────────────────────────────────────────

/**
 * SnapManager manages snap point detection and deposited marker storage.
 */
export class SnapManager {
  /** Visual marker renderer */
  private readonly marker: BuildSnapMarker;

  /** Deposited snap points in world space (FIFO ring buffer) */
  private depositedPoints: THREE.Vector3[] = [];

  /** Spatial hash for fast deposited-point neighbor queries */
  private readonly spatialHash = new SpatialHash();

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
   * Detect snap: find the closest deposited↔current pair using spatial hashing,
   * and collect ALL overlapping pairs for green highlighting.
   * Does NOT update visuals — call updateVisuals() after applying the delta.
   * 
   * @param preset Current build preset
   * @param center Current build center position (world space)
   * @param rotation Current composed rotation quaternion
   * @returns SnapResult with delta and all overlapping indices
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

    // No deposited points → nothing to snap to
    if (this.depositedPoints.length === 0) {
      return NO_SNAP;
    }

    let minDist = SNAP_DISTANCE_MAX;
    let bestDelta: THREE.Vector3 | null = null;
    const snappedDepositedIndices = new Set<number>();
    const snappedCurrentIndices = new Set<number>();

    for (let ci = 0; ci < worldPoints.length; ci++) {
      const wp = worldPoints[ci];
      this._tempCurrent.set(wp.x, wp.y, wp.z);

      // Query only nearby deposited points via spatial hash
      const neighbors = this.spatialHash.queryNeighbors(wp);

      for (let ni = 0; ni < neighbors.length; ni++) {
        const di = neighbors[ni];
        const dp = this.depositedPoints[di];
        const d = this._tempCurrent.distanceTo(dp);

        if (d < SNAP_DISTANCE_MAX) {
          // Collect all overlapping pairs
          snappedDepositedIndices.add(di);
          snappedCurrentIndices.add(ci);

          // Track the closest pair for the snap delta
          if (d < minDist) {
            minDist = d;
            bestDelta = this._tempDelta.clone().subVectors(this._tempCurrent, dp);
          }
        }
      }
    }

    if (bestDelta) {
      return {
        snapped: true,
        delta: bestDelta,
        snappedDepositedIndices,
        snappedCurrentIndices,
      };
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
   * @param snappedDepositedIndices Set of deposited indices to highlight
   * @param snappedCurrentIndices Set of current-shape indices to highlight
   */
  updateVisuals(
    preset: BuildPreset,
    center: Vec3,
    rotation: Quat,
    snappedDepositedIndices: ReadonlySet<number>,
    snappedCurrentIndices: ReadonlySet<number>,
  ): void {
    if (!this._snapPointEnabled || preset.snapShape === BuildPresetSnapShape.NONE) {
      this.marker.updateCurrent([]);
      this.marker.setSnappedSets(EMPTY_SET, EMPTY_SET);
      return;
    }

    const localPoints = this.getLocalPoints(preset);
    if (localPoints.length === 0) {
      this.marker.updateCurrent([]);
      this.marker.setSnappedSets(EMPTY_SET, EMPTY_SET);
      return;
    }

    // Transform to world space at the FINAL (post-snap) position
    const worldPoints = snapPointsToWorld(localPoints, center, rotation);
    const currentPositions = worldPoints.map(p => new THREE.Vector3(p.x, p.y, p.z));
    this.marker.updateCurrent(currentPositions);

    // Highlight all overlapping markers
    this.marker.setSnappedSets(snappedDepositedIndices, snappedCurrentIndices);
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
      const neighbors = this.spatialHash.queryNeighbors(wp);
      let isDuplicate = false;
      for (const ni of neighbors) {
        if (this.depositedPoints[ni].distanceTo(newPos) < 0.01) {
          isDuplicate = true;
          break;
        }
      }
      if (!isDuplicate) {
        this.depositedPoints.push(newPos);
      }
    }

    // FIFO eviction
    while (this.depositedPoints.length > SNAP_MARKER_COUNT_MAX) {
      this.depositedPoints.shift();
    }

    // Rebuild spatial hash and update visuals
    this.spatialHash.rebuild(this.depositedPoints);
    this.marker.updateDeposited(this.depositedPoints);
  }

  /**
   * Clear all deposited markers.
   */
  clearDeposited(): void {
    this.depositedPoints.length = 0;
    this.spatialHash.clear();
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
