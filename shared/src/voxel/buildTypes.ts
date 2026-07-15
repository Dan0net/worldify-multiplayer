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
  /**
   * Punch - a material-filtered subtract. Carves like SUBTRACT but only removes voxels whose
   * existing material equals `config.material` (the target material to match). Used by the
   * left-click "punch": the match material is the voxel the crosshair hit, so punching grass digs
   * a blob of grass without touching adjacent stone/brick.
   */
  PUNCH = 'punch',
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
  /** 3 corners of a triangular prism face (XY, z=0) */
  PRISM = 'prism',
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
 * One part of a composite build: its own shape/material config plus a positional
 * offset (in voxel units) from the operation center, expressed in the operation's
 * canonical (pre-rotation) local space.
 */
export interface BuildPart {
  config: BuildConfig;
  offset: Vec3;
}

/**
 * A complete build operation. Geometry is always expressed as `parts` (a single-shape
 * build is just a one-element list); every part is drawn atomically as one operation.
 */
export interface BuildOperation {
  /** World position center of the build */
  center: Vec3;
  /** Rotation as quaternion (for inverse-rotating voxel positions) */
  rotation: Quat;
  /** Composite parts (>= 1). Drawn atomically. */
  parts: BuildPart[];
}

/**
 * The representative config of a parts list — `parts[0].config`. Used where a single
 * config is needed (marker colour, snap size, thumbnail fallback, config-tab editing).
 */
export function representativeConfig(parts: BuildPart[]): BuildConfig {
  return parts[0].config;
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
