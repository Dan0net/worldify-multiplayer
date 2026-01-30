/**
 * Build presets - predefined build configurations mapped to keyboard 0-9
 */

import { BuildConfig, BuildMode, BuildShape, Size3 } from './buildTypes.js';

/**
 * How to align the build shape relative to the raycast hit point.
 */
export enum BuildPresetAlign {
  /** Center the shape on the hit point */
  CENTER = 'center',
  /** Place the base (bottom) at the hit point */
  BASE = 'base',
  /** Offset from surface by half the shape size (for adding) */
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
 */
export const DEFAULT_BUILD_PRESETS: readonly BuildPreset[] = [
  // 0 = None (disabled)
  {
    id: 0,
    name: 'None',
    config: { shape: BuildShape.CUBE, mode: BuildMode.ADD, size: size(0, 0, 0), material: 0 },
    align: BuildPresetAlign.CENTER,
  },
  // 1 = Small cube add
  {
    id: 1,
    name: 'Small Cube',
    config: { shape: BuildShape.CUBE, mode: BuildMode.ADD, size: size(1, 1, 1), material: 1 },
    align: BuildPresetAlign.SURFACE,
  },
  // 2 = Small cube subtract
  {
    id: 2,
    name: 'Cube Carve',
    config: { shape: BuildShape.CUBE, mode: BuildMode.SUBTRACT, size: size(1, 1, 1), material: 1 },
    align: BuildPresetAlign.CENTER,
  },
  // 3 = Medium sphere add
  {
    id: 3,
    name: 'Sphere Add',
    config: { shape: BuildShape.SPHERE, mode: BuildMode.ADD, size: size(2, 2, 2), material: 2 },
    align: BuildPresetAlign.SURFACE,
  },
  // 4 = Medium sphere subtract
  {
    id: 4,
    name: 'Sphere Carve',
    config: { shape: BuildShape.SPHERE, mode: BuildMode.SUBTRACT, size: size(2, 2, 2), material: 2 },
    align: BuildPresetAlign.CENTER,
  },
  // 5 = Large cube add
  {
    id: 5,
    name: 'Large Cube',
    config: { shape: BuildShape.CUBE, mode: BuildMode.ADD, size: size(4, 4, 4), material: 3 },
    align: BuildPresetAlign.SURFACE,
  },
  // 6 = Pillar (cylinder add)
  {
    id: 6,
    name: 'Pillar',
    config: { shape: BuildShape.CYLINDER, mode: BuildMode.ADD, size: size(1, 3, 1), material: 4 },
    align: BuildPresetAlign.BASE,
  },
  // 7 = Tunnel (cylinder subtract)
  {
    id: 7,
    name: 'Tunnel',
    config: { shape: BuildShape.CYLINDER, mode: BuildMode.SUBTRACT, size: size(2, 4, 2), material: 4 },
    align: BuildPresetAlign.CENTER,
  },
  // 8 = Paint brush
  {
    id: 8,
    name: 'Paint',
    config: { shape: BuildShape.SPHERE, mode: BuildMode.PAINT, size: size(2, 2, 2), material: 5 },
    align: BuildPresetAlign.CENTER,
  },
  // 9 = Fill cube
  {
    id: 9,
    name: 'Fill',
    config: { shape: BuildShape.CUBE, mode: BuildMode.FILL, size: size(2, 2, 2), material: 6 },
    align: BuildPresetAlign.SURFACE,
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
 * Maximum build distance in world units (meters).
 */
export const MAX_BUILD_DISTANCE = 20;

/**
 * Rotation step in degrees (45° increments).
 */
export const BUILD_ROTATION_STEP = 45;
