/**
 * Snap point generation for build presets.
 * 
 * Generates snap points relative to the build shape center based on the
 * preset's snapShape and size. Points are in local space (before rotation/translation).
 * 
 * Used by the client SnapManager to deposit and match snap points.
 */

import { BuildPresetSnapShape } from './buildTypes.js';
import type { Size3 } from './buildTypes.js';
import type { Vec3, Quat } from '../util/math.js';
import { applyQuatToVec3 } from '../util/math.js';
import { VOXEL_SCALE } from './constants.js';

/** Maximum snap distance in world units (meters) */
export const SNAP_DISTANCE_MAX = 0.5;

/** Maximum number of deposited snap markers before FIFO eviction */
export const SNAP_MARKER_COUNT_MAX = 80;

/**
 * Generate snap points in local space for a given snap shape and size.
 * Size values are in voxel half-extents; output is in world units (meters).
 * 
 * @param snapShape The snap shape type
 * @param size Half-extents of the build shape in voxel units
 * @returns Array of local-space snap points (world units)
 */
export function generateSnapPointsLocal(snapShape: BuildPresetSnapShape, size: Size3): Vec3[] {
  const sx = size.x * VOXEL_SCALE;
  const sy = size.y * VOXEL_SCALE;
  const sz = size.z * VOXEL_SCALE;

  switch (snapShape) {
    case BuildPresetSnapShape.CUBE:
      return [
        { x: sx, y: sy, z: sz },
        { x: -sx, y: sy, z: sz },
        { x: sx, y: -sy, z: sz },
        { x: -sx, y: -sy, z: sz },
        { x: sx, y: sy, z: -sz },
        { x: -sx, y: sy, z: -sz },
        { x: sx, y: -sy, z: -sz },
        { x: -sx, y: -sy, z: -sz },
      ];

    case BuildPresetSnapShape.PLANE:
      return [
        { x: sx, y: sy, z: 0 },
        { x: -sx, y: sy, z: 0 },
        { x: sx, y: -sy, z: 0 },
        { x: -sx, y: -sy, z: 0 },
      ];

    case BuildPresetSnapShape.PRISM:
      // 3 corners of a right-angled triangular prism face (matching SDF):
      // top-left, bottom-left (right angle), bottom-right
      return [
        { x: -sx, y: sy, z: 0 },
        { x: -sx, y: -sy, z: 0 },
        { x: sx, y: -sy, z: 0 },
      ];

    case BuildPresetSnapShape.LINE:
      return [
        { x: 0, y: sy, z: 0 },
        { x: 0, y: -sy, z: 0 },
      ];

    case BuildPresetSnapShape.POINT:
      return [{ x: 0, y: 0, z: 0 }];

    case BuildPresetSnapShape.CYLINDER:
      return [
        { x: sx, y: sy, z: 0 },
        { x: sx, y: -sy, z: 0 },
        { x: -sx, y: sy, z: 0 },
        { x: -sx, y: -sy, z: 0 },
        { x: 0, y: sy, z: sx },
        { x: 0, y: -sy, z: sx },
        { x: 0, y: sy, z: -sx },
        { x: 0, y: -sy, z: -sx },
        { x: 0, y: sy, z: 0 },
        { x: 0, y: -sy, z: 0 },
      ];

    case BuildPresetSnapShape.NONE:
    default:
      return [];
  }
}

/**
 * Transform local snap points to world space given a center position and rotation.
 * 
 * @param localPoints Snap points in local space
 * @param center World position of the build shape center
 * @param rotation Quaternion rotation applied to the build shape
 * @returns Array of world-space snap points
 */
export function snapPointsToWorld(
  localPoints: Vec3[],
  center: Vec3,
  rotation: Quat,
): Vec3[] {
  return localPoints.map(p => {
    const rotated = applyQuatToVec3(p, rotation);
    return {
      x: rotated.x + center.x,
      y: rotated.y + center.y,
      z: rotated.z + center.z,
    };
  });
}
