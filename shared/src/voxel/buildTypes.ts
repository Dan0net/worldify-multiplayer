/**
 * Build system types - shared between client and server
 */

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
 * 3D position vector.
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Quaternion for rotation.
 */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
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

/**
 * Create an identity quaternion (no rotation).
 */
export function identityQuat(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 };
}

/**
 * Apply quaternion rotation to a vector.
 * Returns a new vector (does not mutate input).
 */
export function applyQuatToVec3(v: Vec3, q: Quat): Vec3 {
  // Quaternion rotation: v' = q * v * q^-1
  // Optimized formula using q = (x, y, z, w)
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const vx = v.x, vy = v.y, vz = v.z;

  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);

  // result = v + w * t + cross(q.xyz, t)
  return {
    x: vx + qw * tx + (qy * tz - qz * ty),
    y: vy + qw * ty + (qz * tx - qx * tz),
    z: vz + qw * tz + (qx * ty - qy * tx),
  };
}

/**
 * Get the inverse (conjugate) of a quaternion.
 * For unit quaternions, conjugate = inverse.
 */
export function invertQuat(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/**
 * Multiply two quaternions: result = a * b
 * Applies rotation b first, then a (standard quaternion composition).
 */
export function multiplyQuats(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/**
 * Create a quaternion for rotation around the X axis.
 * @param radians - The rotation angle in radians
 */
export function xRotationQuat(radians: number): Quat {
  const halfAngle = radians * 0.5;
  return {
    x: Math.sin(halfAngle),
    y: 0,
    z: 0,
    w: Math.cos(halfAngle),
  };
}

/**
 * Create a quaternion for rotation around the Y axis.
 * @param radians - The rotation angle in radians
 */
export function yRotationQuat(radians: number): Quat {
  const halfAngle = radians * 0.5;
  return {
    x: 0,
    y: Math.sin(halfAngle),
    z: 0,
    w: Math.cos(halfAngle),
  };
}

// Re-export clamp from math utilities for backwards compatibility
export { clamp } from '../util/math.js';
