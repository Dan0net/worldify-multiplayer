/**
 * Build system types - shared between client and server
 */

// Import 3D math types for local use & re-export from util/math (canonical location)
import type { Vec3, Quat } from '../util/math.js';
export type { Vec3, Quat } from '../util/math.js';
export {
  identityQuat,
  invertQuat,
  multiplyQuats,
  applyQuatToVec3,
  xRotationQuat,
  yRotationQuat,
} from '../util/math.js';

// ============== Enums ==============

/**
 * Build mode determines how the shape affects existing voxels.
 */
export enum BuildMode {
  /** Add material - takes max of existing and new weight */
  ADD = 'add',
  /** Subtract material - takes min of existing and new weight */
  SUBTRACT = 'subtract',
  /** Paint - changes material only where weight > 0 */
  PAINT = 'paint',
  /** Fill - only fills where existing weight <= 0 */
  FILL = 'fill',
}

/**
 * Available build shapes.
 */
export enum BuildShape {
  CUBE = 'cube',
  SPHERE = 'sphere',
  CYLINDER = 'cylinder',
  PRISM = 'prism',
}

/**
 * Snap shape determines which corners/edges of a build shape generate snap points.
 */
export enum BuildPresetSnapShape {
  /** No snap points */
  NONE = 'none',
  /** 8 corners of a box */
  CUBE = 'cube',
  /** 4 corners of a rectangular plane (XY) */
  PLANE = 'plane',
  /** 2 endpoints along Y axis */
  LINE = 'line',
  /** Single point at center */
  POINT = 'point',
  /** 10 points around cylinder (cardinal + top/bottom center) */
  CYLINDER = 'cylinder',
}

// ============== Interfaces ==============

/**
 * 3D size vector for shapes.
 */
export interface Size3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Configuration for a build operation.
 */
export interface BuildConfig {
  /** Shape type */
  shape: BuildShape;
  /** How the shape affects voxels */
  mode: BuildMode;
  /** Size of the shape in voxel units */
  size: Size3;
  /** Material ID to apply (0-127) */
  material: number;
  /** Wall thickness for hollow shapes (optional) */
  thickness?: number;
  /** Whether hollow shapes are closed at top/bottom */
  closed?: boolean;
  /** Arc sweep angle in radians for partial shapes (optional) */
  arcSweep?: number;
}

/**
 * A complete build operation with position and rotation.
 */
export interface BuildOperation {
  /** World position center of the build */
  center: Vec3;
  /** Rotation as quaternion (for inverse-rotating voxel positions) */
  rotation: Quat;
  /** Build configuration */
  config: BuildConfig;
}

/**
 * Axis-aligned bounding box in voxel coordinates.
 */
export interface VoxelBBox {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

// ============== Utility Functions ==============

/**
 * Create a default build config.
 */
export function createDefaultBuildConfig(): BuildConfig {
  return {
    shape: BuildShape.CUBE,
    mode: BuildMode.ADD,
    size: { x: 2, y: 2, z: 2 },
    material: 1,
  };
}

// Re-export clamp from math utilities for backwards compatibility
export { clamp } from '../util/math.js';
