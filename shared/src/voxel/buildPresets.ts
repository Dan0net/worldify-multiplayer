/**
 * Build presets - predefined build configurations mapped to keyboard 0-9
 * Ported from worldify-app's BuildPresets.ts with architecture-appropriate types.
 *
 * Geometry is always expressed as `parts: BuildPart[]` — a simple preset is just a
 * one-element list at zero offset; composite presets (e.g. the Torch) list several
 * shapes with per-part offsets. There is no separate single `config`; where a single
 * representative is needed, use `parts[0].config` (see `representativeConfig`).
 */

import { BuildConfig, BuildMode, BuildPart, BuildPresetSnapShape, BuildShape, Size3, Vec3 } from './buildTypes.js';
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
  /** Carve into surface: auto-rotates to face normal and projects INTO the voxels */
  CARVE = 'carve',
  /** Base at surface; rotates so the shape points OUT along the face normal
   *  (up off floors, down off ceilings, sideways off walls) */
  POINT_OUT = 'point-out',
}

/**
 * Per-slot metadata that sits alongside a preset's geometry.
 * Stores the preset-level properties that affect placement behavior.
 */
export interface PresetSlotMeta {
  /** Display name for this slot's current preset template */
  templateName: string;
  /** How to position relative to hit point */
  align: BuildPresetAlign;
  /** Shape of snap points generated for this preset */
  snapShape: BuildPresetSnapShape;
  /** Baked-in base rotation quaternion (user Y rotation composed on top) */
  baseRotation?: Quat;
  /** When true, the shape auto-rotates to face the hit surface normal */
  autoRotateY?: boolean;
  /** Composite parts (>= 1). The editable geometry for this slot. */
  parts: BuildPart[];
}

/**
 * A named build preset with geometry and alignment.
 */
export interface BuildPreset {
  /** Preset ID (0-9, mapped to keyboard) */
  id: number;
  /** Display name */
  name: string;
  /** Composite parts (>= 1). Simple presets have a single zero-offset part. */
  parts: BuildPart[];
  /** How to position relative to hit point */
  align: BuildPresetAlign;
  /**
   * Baked-in base rotation for the preset shape (e.g. floors rotated 90° on X).
   * User's Y-axis rotation (Q/E) is composed on top of this.
   * If omitted, treated as identity (no base rotation).
   */
  baseRotation?: Quat;
  /** Shape of snap points generated for this preset */
  snapShape: BuildPresetSnapShape;
  /**
   * When true, the shape auto-rotates around the Y axis to face the
   * hit surface normal. User Q/E rotation is ignored.
   */
  autoRotateY?: boolean;
}

/**
 * Create a size object.
 */
function size(x: number, y: number, z: number): Size3 {
  return { x, y, z };
}

/**
 * Create a build part (a shape config + canonical offset in voxel units).
 * Offset defaults to the origin — simple single-shape presets place at the aligned center.
 */
function part(config: BuildConfig, offset: Vec3 = { x: 0, y: 0, z: 0 }): BuildPart {
  return { config, offset };
}

/** Preset ID for the "None" (disabled) preset */
export const NONE_PRESET_ID = 1;

/**
 * The Torch shape as a parts list — the single source of truth reused by the build preset
 * (below) AND terrain generation (rasterized into stamp voxels). Authored pointing +Y: a wood
 * column (base at origin) with a glowing lava sphere on top.
 */
export const TORCH_PARTS: BuildPart[] = [
  part({ shape: BuildShape.CUBE, mode: BuildMode.ADD, size: size(0.71, 2, 0.71), material: 2 }, { x: 0, y: 2, z: 0 }),
  part({ shape: BuildShape.SPHERE, mode: BuildMode.ADD, size: size(1, 1, 1), material: 50 }, { x: 0, y: 4, z: 0 }),
];

/** A single-cube parts list for a material — used by material-swatch thumbnails (client + preload). */
export function materialCubeParts(material: number, half = 4): BuildPart[] {
  return [part({ shape: BuildShape.CUBE, mode: BuildMode.ADD, size: size(half, half, half), material })];
}

/**
 * Default build presets (10 total, mapped to keys 0-9).
 * Preset 1 is "None" (building disabled) — key 1 is the default.
 */
export const DEFAULT_BUILD_PRESETS: readonly BuildPreset[] = [
  // 0 = Blob paint (sphere, paint, centered) — last in keyboard layout
  {
    id: 0,
    name: 'Paint',
    parts: [part({ shape: BuildShape.SPHERE, mode: BuildMode.PAINT, size: size(2, 2, 2), material: 1 })],
    align: BuildPresetAlign.CENTER,
    snapShape: BuildPresetSnapShape.NONE,
  },
  // 1 = None (disabled)
  {
    id: 1,
    name: 'None',
    parts: [part({ shape: BuildShape.CUBE, mode: BuildMode.ADD, size: size(0, 0, 0), material: 0 })],
    align: BuildPresetAlign.CENTER,
    snapShape: BuildPresetSnapShape.POINT,
  },
  // 2 = Brick wall (cube, add, thin slab, base-projected)
  {
    id: 2,
    name: 'Brick Wall',
    parts: [part({ shape: BuildShape.CUBE, mode: BuildMode.ADD, size: size(4, 4, 0.71), material: 6 })],
    align: BuildPresetAlign.PROJECT,
    snapShape: BuildPresetSnapShape.PLANE,
  },
  // 3 = Stone stairs (cube, fill, angled slab, base-projected)
  {
    id: 3,
    name: 'Stairs',
    parts: [part({
      shape: BuildShape.CUBE, mode: BuildMode.FILL,
      size: size(4, Math.sqrt(2 ** 2 + 4 ** 2), 1),
      material: 29,
    })],
    align: BuildPresetAlign.PROJECT,
    baseRotation: xRotationQuat(Math.atan(4 / 2)),
    snapShape: BuildPresetSnapShape.PLANE,
  },
  // 4 = Wooden pillar (cube, add, tall narrow, base-aligned)
  {
    id: 4,
    name: 'Wood Pillar',
    parts: [part({ shape: BuildShape.CUBE, mode: BuildMode.ADD, size: size(1, 4, 1), material: 5 })],
    align: BuildPresetAlign.BASE,
    snapShape: BuildPresetSnapShape.LINE,
  },
  // 5 = Wooden beam (cube, add, tall narrow rotated horizontal, base-projected)
  {
    id: 5,
    name: 'Wood Beam',
    parts: [part({ shape: BuildShape.CUBE, mode: BuildMode.ADD, size: size(1, 4, 1), material: 5 })],
    align: BuildPresetAlign.PROJECT,
    baseRotation: xRotationQuat(Math.PI / 2),
    snapShape: BuildPresetSnapShape.LINE,
  },
  // 6 = Stone floor (cube, fill, thin slab rotated flat, base-projected)
  {
    id: 6,
    name: 'Stone Floor',
    parts: [part({ shape: BuildShape.CUBE, mode: BuildMode.FILL, size: size(4, 4, 0.71), material: 8 })],
    align: BuildPresetAlign.PROJECT,
    baseRotation: xRotationQuat(Math.PI / 2),
    snapShape: BuildPresetSnapShape.PLANE,
  },
  // 7 = Leafy blob (sphere, fill, centered)
  {
    id: 7,
    name: 'Leafy Blob',
    parts: [part({ shape: BuildShape.SPHERE, mode: BuildMode.FILL, size: size(3, 3, 3), material: 48 })],
    align: BuildPresetAlign.CENTER,
    snapShape: BuildPresetSnapShape.NONE,
  },
  // 8 = Blob carve (sphere, subtract, centered)
  {
    id: 8,
    name: 'Blob Carve',
    parts: [part({ shape: BuildShape.SPHERE, mode: BuildMode.SUBTRACT, size: size(2, 2, 2), material: 1 })],
    align: BuildPresetAlign.CENTER,
    snapShape: BuildPresetSnapShape.NONE,
  },
  // 9 = Door carve (cube, subtract, auto-rotates to face wall and carves inward)
  {
    id: 9,
    name: 'Door Carve',
    parts: [part({ shape: BuildShape.CUBE, mode: BuildMode.SUBTRACT, size: size(4, 6, 3), material: 0 })],
    align: BuildPresetAlign.CARVE,
    autoRotateY: true,
    snapShape: BuildPresetSnapShape.NONE,
  },
] as const;

/**
 * Get a preset by ID.
 * Returns the None preset if ID is out of range.
 */
export function getPreset(id: number): BuildPreset {
  return DEFAULT_BUILD_PRESETS[id] ?? DEFAULT_BUILD_PRESETS[NONE_PRESET_ID];
}

// ============== Preset Template Catalog ==============

/**
 * A preset template from the full catalog.
 * Does not have an ID — IDs are assigned when placed into a slot.
 */
export interface BuildPresetTemplate {
  /** Display name */
  name: string;
  /** Category for UI grouping */
  category: PresetCategory;
  /** Composite parts (>= 1). */
  parts: BuildPart[];
  /** How to position relative to hit point */
  align: BuildPresetAlign;
  /** Baked-in base rotation */
  baseRotation?: Quat;
  /** Shape of snap points generated */
  snapShape: BuildPresetSnapShape;
  /** When true, auto-rotates to face hit surface */
  autoRotateY?: boolean;
}

/** Categories for organizing presets in the menu */
export enum PresetCategory {
  WALLS = 'Walls',
  FLOORS = 'Floors',
  STAIRS = 'Stairs & Ramps',
  STRUCTURAL = 'Structural',
  TERRAIN = 'Terrain Tools',
}

/**
 * Full catalog of preset templates from worldify-app.
 * Players can assign any of these to their 10 hotbar slots.
 */
export const PRESET_TEMPLATES: readonly BuildPresetTemplate[] = [
  // ---- Walls ----
  {
    name: 'Brick Wall',
    category: PresetCategory.WALLS,
    parts: [part({ shape: BuildShape.CUBE, mode: BuildMode.ADD, size: size(4, 4, 0.71), material: 6 })],
    align: BuildPresetAlign.PROJECT,
    snapShape: BuildPresetSnapShape.PLANE,
  },
  {
    name: 'Half Brick Wall',
    category: PresetCategory.WALLS,
    parts: [part({ shape: BuildShape.CUBE, mode: BuildMode.ADD, size: size(2, 2, 0.71), material: 6 })],
    align: BuildPresetAlign.PROJECT,
    snapShape: BuildPresetSnapShape.PLANE,
  },
  {
    name: 'Shallow Slope Wall',
    category: PresetCategory.WALLS,
    parts: [part({ shape: BuildShape.PRISM, mode: BuildMode.ADD, size: size(4, 2, 0.71), material: 6 })],
    align: BuildPresetAlign.PROJECT,
    snapShape: BuildPresetSnapShape.PRISM,
  },
  {
    name: 'Half Slope Wall',
    category: PresetCategory.WALLS,
    parts: [part({ shape: BuildShape.PRISM, mode: BuildMode.ADD, size: size(4, 4, 0.71), material: 6 })],
    align: BuildPresetAlign.PROJECT,
    snapShape: BuildPresetSnapShape.PRISM,
  },
  {
    name: 'Steep Slope Wall',
    category: PresetCategory.WALLS,
    parts: [part({ shape: BuildShape.PRISM, mode: BuildMode.ADD, size: size(2, 4, 0.71), material: 6 })],
    align: BuildPresetAlign.PROJECT,
    snapShape: BuildPresetSnapShape.PRISM,
  },
  {
    name: 'Curved Wall',
    category: PresetCategory.WALLS,
    parts: [part({ shape: BuildShape.CYLINDER, mode: BuildMode.ADD, size: size(8, 4, 8), material: 6, thickness: 1, arcSweep: Math.PI / 2 })],
    align: BuildPresetAlign.BASE,
    snapShape: BuildPresetSnapShape.CYLINDER,
  },

  // ---- Floors ----
  {
    name: 'Stone Floor',
    category: PresetCategory.FLOORS,
    parts: [part({ shape: BuildShape.CUBE, mode: BuildMode.FILL, size: size(4, 4, 0.71), material: 8 })],
    align: BuildPresetAlign.PROJECT,
    baseRotation: xRotationQuat(Math.PI / 2),
    snapShape: BuildPresetSnapShape.PLANE,
  },
  {
    name: 'Half Stone Floor',
    category: PresetCategory.FLOORS,
    parts: [part({ shape: BuildShape.CUBE, mode: BuildMode.FILL, size: size(2, 2, 0.71), material: 8 })],
    align: BuildPresetAlign.PROJECT,
    baseRotation: xRotationQuat(Math.PI / 2),
    snapShape: BuildPresetSnapShape.PLANE,
  },

  // ---- Stairs & Ramps ----
  {
    name: 'Stone Stairs',
    category: PresetCategory.STAIRS,
    parts: [part({
      shape: BuildShape.CUBE, mode: BuildMode.FILL,
      size: size(4, Math.sqrt(2 ** 2 + 4 ** 2), 1),
      material: 29,
    })],
    align: BuildPresetAlign.PROJECT,
    baseRotation: xRotationQuat(Math.atan(4 / 2)),
    snapShape: BuildPresetSnapShape.PLANE,
  },
  {
    name: 'Steep Stone Stairs',
    category: PresetCategory.STAIRS,
    parts: [part({
      shape: BuildShape.CUBE, mode: BuildMode.FILL,
      size: size(4, Math.sqrt(4 ** 2 + 4 ** 2), 1),
      material: 29,
    })],
    align: BuildPresetAlign.PROJECT,
    baseRotation: xRotationQuat(Math.atan(4 / 4)),
    snapShape: BuildPresetSnapShape.PLANE,
  },
  {
    name: 'Shallow Slope Ramp',
    category: PresetCategory.STAIRS,
    parts: [part({
      shape: BuildShape.CUBE, mode: BuildMode.FILL,
      size: size(4, Math.sqrt(2 ** 2 + 4 ** 2), 1),
      material: 29,
    })],
    align: BuildPresetAlign.PROJECT,
    baseRotation: xRotationQuat(Math.atan(2 / 4)),
    snapShape: BuildPresetSnapShape.PLANE,
  },

  // ---- Structural ----
  {
    name: 'Wood Pillar',
    category: PresetCategory.STRUCTURAL,
    parts: [part({ shape: BuildShape.CUBE, mode: BuildMode.ADD, size: size(1, 4, 1), material: 5 })],
    align: BuildPresetAlign.BASE,
    snapShape: BuildPresetSnapShape.LINE,
  },
  {
    name: 'Wood Beam',
    category: PresetCategory.STRUCTURAL,
    parts: [part({ shape: BuildShape.CUBE, mode: BuildMode.ADD, size: size(1, 4, 1), material: 5 })],
    align: BuildPresetAlign.PROJECT,
    baseRotation: xRotationQuat(Math.PI / 2),
    snapShape: BuildPresetSnapShape.LINE,
  },
  {
    // Composite: a wood column with a glowing lava tip. Authored pointing +Y (base at the
    // origin, extending up); POINT_OUT rotates +Y onto the targeted face normal.
    name: 'Torch',
    category: PresetCategory.STRUCTURAL,
    align: BuildPresetAlign.POINT_OUT,
    snapShape: BuildPresetSnapShape.NONE,
    parts: TORCH_PARTS,
  },
  {
    name: 'Brick Cylinder',
    category: PresetCategory.STRUCTURAL,
    parts: [part({ shape: BuildShape.CYLINDER, mode: BuildMode.ADD, size: size(4, 4, 1), material: 6, thickness: 1 })],
    align: BuildPresetAlign.BASE,
    snapShape: BuildPresetSnapShape.CYLINDER,
  },
  {
    name: 'Hollow Cube',
    category: PresetCategory.STRUCTURAL,
    parts: [part({ shape: BuildShape.CUBE, mode: BuildMode.ADD, size: size(8, 8, 8), material: 3, thickness: 1 })],
    align: BuildPresetAlign.PROJECT,
    snapShape: BuildPresetSnapShape.CUBE,
  },

  // ---- Terrain Tools ----
  {
    name: 'Blob Paint',
    category: PresetCategory.TERRAIN,
    parts: [part({ shape: BuildShape.SPHERE, mode: BuildMode.PAINT, size: size(2, 2, 2), material: 1 })],
    align: BuildPresetAlign.CENTER,
    snapShape: BuildPresetSnapShape.NONE,
  },
  {
    name: 'Blob Carve',
    category: PresetCategory.TERRAIN,
    parts: [part({ shape: BuildShape.SPHERE, mode: BuildMode.SUBTRACT, size: size(2, 2, 2), material: 1 })],
    align: BuildPresetAlign.CENTER,
    snapShape: BuildPresetSnapShape.NONE,
  },
  {
    name: 'Leafy Blob',
    category: PresetCategory.TERRAIN,
    parts: [part({ shape: BuildShape.SPHERE, mode: BuildMode.FILL, size: size(3, 3, 3), material: 48 })],
    align: BuildPresetAlign.CENTER,
    snapShape: BuildPresetSnapShape.NONE,
  },
  {
    name: 'Door Carve',
    category: PresetCategory.TERRAIN,
    parts: [part({ shape: BuildShape.CUBE, mode: BuildMode.SUBTRACT, size: size(4, 6, 3), material: 0 })],
    align: BuildPresetAlign.CARVE,
    autoRotateY: true,
    snapShape: BuildPresetSnapShape.NONE,
  },
  {
    name: 'Flatten',
    category: PresetCategory.TERRAIN,
    parts: [part({ shape: BuildShape.CYLINDER, mode: BuildMode.SUBTRACT, size: size(8, 4, 1), material: 1 })],
    align: BuildPresetAlign.BASE,
    snapShape: BuildPresetSnapShape.CYLINDER,
  },
];

/**
 * Extract PresetSlotMeta from a BuildPresetTemplate.
 */
export function templateToSlotMeta(template: BuildPresetTemplate): PresetSlotMeta {
  return {
    templateName: template.name,
    align: template.align,
    snapShape: template.snapShape,
    baseRotation: template.baseRotation,
    autoRotateY: template.autoRotateY,
    parts: clonePartsList(template.parts),
  };
}

/**
 * Extract PresetSlotMeta from a BuildPreset (default hotbar preset).
 */
export function presetToSlotMeta(preset: BuildPreset): PresetSlotMeta {
  return {
    templateName: preset.name,
    align: preset.align,
    snapShape: preset.snapShape,
    baseRotation: preset.baseRotation,
    autoRotateY: preset.autoRotateY,
    parts: clonePartsList(preset.parts),
  };
}

/** Deep-clone a parts list so slot edits never mutate the shared catalog/default objects. */
export function clonePartsList(parts: BuildPart[]): BuildPart[] {
  return parts.map((p) => ({
    config: { ...p.config, size: { ...p.config.size } },
    offset: { ...p.offset },
  }));
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
export const BUILD_PROJECTION_DEADZONE = Math.sin(BUILD_ROTATION_STEP_RAD / 2.0);
