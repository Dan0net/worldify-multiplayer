/**
 * Build presets - predefined build configurations mapped to keyboard 0-9
 * Ported from worldify-app's BuildPresets.ts with architecture-appropriate types.
 */

import { BuildConfig, BuildMode, BuildShape, Size3 } from './buildTypes.js';
import {
  Quat, yRotationQuat, xRotationQuat, multiplyQuats,
} from '../util/math.js';

/**
 * How to align the build shape relative to the raycast hit point.
 */
export enum BuildPresetAlign {
  /** Center the shape on the hit point */
  CENTER = 'center',
  /** Place the base (bottom) at the hit point */
  BASE = 'base',
  /** Projected along surface normal: base at surface on horizontal, fully protrudes on vertical */
  PROJECT = 'project',
  /** Offset from surface by half the shape size (for carving into surfaces) */
  SURFACE = 'surface',
}

/**
 * A named build preset with configuration and alignment.
 */
export interface BuildPreset {
  /** Preset ID (0-9, mapped to keyboard) */
  id: number;
  /** Display name */
  name: string;
  /** Build configuration (shape, mode, size, material) */
  config: BuildConfig;
  /** How to position relative to hit point */
  align: BuildPresetAlign;
  /**
   * Baked-in base rotation for the preset shape (e.g. floors rotated 90° on X).
   * User's Y-axis rotation (Q/E) is composed on top of this.
   * If omitted, treated as identity (no base rotation).
   */
  baseRotation?: Quat;
}

/**
 * Create a size object.
 */
function size(x: number, y: number, z: number): Size3 {
  return { x, y, z };
}

/**
 * Default build presets (10 total, mapped to keys 0-9).
 * Preset 0 is "None" (building disabled).
 *
 * Ported from worldify-app BuildPresets — first 10 items mapped to hotbar.
 * Material IDs match the shared pallet (pallet.json indices are identical).
 */
export const DEFAULT_BUILD_PRESETS: readonly BuildPreset[] = [
  // 0 = None (disabled)
  {
    id: 0,
    name: 'None',
    config: { shape: BuildShape.CUBE, mode: BuildMode.ADD, size: size(0, 0, 0), material: 0 },
    align: BuildPresetAlign.CENTER,
  },
  // 1 = Brick wall (cube, add, thin slab, base-projected)
  {
    id: 1,
    name: 'Brick Wall',
    config: { shape: BuildShape.CUBE, mode: BuildMode.ADD, size: size(4, 4, 0.71), material: 6 },
    align: BuildPresetAlign.PROJECT,
  },
  // 2 = Stone floor (cube, fill, thin slab rotated flat, base-projected)
  {
    id: 2,
    name: 'Stone Floor',
    config: { shape: BuildShape.CUBE, mode: BuildMode.FILL, size: size(4, 4, 0.71), material: 8 },
    align: BuildPresetAlign.PROJECT,
    baseRotation: xRotationQuat(Math.PI / 2),
  },
  // 3 = Wooden pillar (cube, add, tall narrow, base-aligned)
  {
    id: 3,
    name: 'Wood Pillar',
    config: { shape: BuildShape.CUBE, mode: BuildMode.ADD, size: size(1, 4, 1), material: 5 },
    align: BuildPresetAlign.BASE,
  },
  // 4 = Wooden beam (cube, add, tall narrow rotated horizontal, base-projected)
  {
    id: 4,
    name: 'Wood Beam',
    config: { shape: BuildShape.CUBE, mode: BuildMode.ADD, size: size(1, 4, 1), material: 5 },
    align: BuildPresetAlign.PROJECT,
    baseRotation: xRotationQuat(Math.PI / 2),
  },
  // 5 = Leafy blob (sphere, fill, centered)
  {
    id: 5,
    name: 'Leafy Blob',
    config: { shape: BuildShape.SPHERE, mode: BuildMode.FILL, size: size(2, 2, 2), material: 48 },
    align: BuildPresetAlign.CENTER,
  },
  // 6 = Stone stairs (cube, fill, angled slab, base-projected)
  {
    id: 6,
    name: 'Stairs',
    config: {
      shape: BuildShape.CUBE, mode: BuildMode.FILL,
      size: size(4, Math.sqrt(2 ** 2 + 4 ** 2), 1),
      material: 29,
    },
    align: BuildPresetAlign.PROJECT,
    baseRotation: xRotationQuat(Math.atan(4 / 2)),
  },
  // 7 = Blob carve (sphere, subtract, centered)
  {
    id: 7,
    name: 'Blob Carve',
    config: { shape: BuildShape.SPHERE, mode: BuildMode.SUBTRACT, size: size(2, 2, 2), material: 1 },
    align: BuildPresetAlign.CENTER,
  },
  // 8 = Door carve (cube, subtract, surface-aligned)
  {
    id: 8,
    name: 'Door Carve',
    config: { shape: BuildShape.CUBE, mode: BuildMode.SUBTRACT, size: size(4, 6, 3), material: 0 },
    align: BuildPresetAlign.SURFACE,
  },
  // 9 = Blob paint (sphere, paint, centered)
  {
    id: 9,
    name: 'Paint',
    config: { shape: BuildShape.SPHERE, mode: BuildMode.PAINT, size: size(2, 2, 2), material: 1 },
    align: BuildPresetAlign.CENTER,
  },
] as const;

/**
 * Get a preset by ID.
 * Returns preset 0 (None) if ID is out of range.
 */
export function getPreset(id: number): BuildPreset {
  return DEFAULT_BUILD_PRESETS[id] ?? DEFAULT_BUILD_PRESETS[0];
}

/**
 * Compose the final rotation quaternion for a build operation.
 * Combines the preset's baked base rotation with the user's Y-axis rotation.
 * Order: baseRotation * yRotation (base first, then user spins around Y).
 */
export function composeRotation(preset: BuildPreset, userYRadians: number): Quat {
  const userRot = yRotationQuat(userYRadians);
  if (!preset.baseRotation) return userRot;
  return multiplyQuats(userRot, preset.baseRotation);
}

/**
 * Maximum build distance in world units (meters).
 */
export const MAX_BUILD_DISTANCE = 20;

/**
 * Number of rotation steps in a full rotation.
 */
export const BUILD_ROTATION_STEPS = 16;

/**
 * Rotation step in degrees (360 / BUILD_ROTATION_STEPS).
 */
export const BUILD_ROTATION_STEP = 360 / BUILD_ROTATION_STEPS;

/**
 * Rotation step in radians.
 */
export const BUILD_ROTATION_STEP_RAD = (BUILD_ROTATION_STEP * Math.PI) / 180;

/**
 * Projection deadzone: axes with less normal contribution than one rotation step
 * are considered parallel to the surface. Equal to sin(BUILD_ROTATION_STEP_RAD).
 */
export const BUILD_PROJECTION_DEADZONE = Math.sin(BUILD_ROTATION_STEP_RAD);
