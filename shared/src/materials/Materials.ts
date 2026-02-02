/**
 * Material definitions and lookup utilities
 *
 * Provides type-safe material name references that map to pallet.json indices.
 * Use material names in code (e.g., 'moss2', 'rock') and look up IDs at runtime.
 */

import pallet from './pallet.json' with { type: 'json' };

// Export the raw pallet for client use
export { pallet as MATERIAL_PALLET };

// ============== Types ==============

/** All valid material names from pallet.json */
export type MaterialName = keyof typeof pallet.indicies;

/** Material type categories */
export type MaterialType = 'solid' | 'liquid' | 'transparent';

// ============== Raw Data ==============

/** Map of material name -> material ID (0-indexed) */
export const MATERIAL_IDS = pallet.indicies as Record<MaterialName, number>;

/** Array of all material names in order */
export const MATERIAL_NAMES = pallet.materials as MaterialName[];

/** Array of material colors (hex strings) indexed by material ID */
export const MATERIAL_COLORS = pallet.colors;

// ============== Materials API ==============

/**
 * Materials lookup utilities.
 * All methods are type-safe - invalid material names cause compile errors.
 */
export const Materials = {
  /**
   * Get the material ID for a material name.
   * @example
   * const grass = Materials.get('moss2');     // 0
   * const rock = Materials.get('rock');       // 1
   */
  get(name: MaterialName): number {
    return MATERIAL_IDS[name];
  },

  /**
   * Get material IDs for multiple material names.
   * @example
   * const [grass, rock, dirt] = Materials.getMany(['moss2', 'rock', 'dirt']);
   */
  getMany<T extends MaterialName[]>(names: [...T]): { [K in keyof T]: number } {
    return names.map(name => MATERIAL_IDS[name]) as { [K in keyof T]: number };
  },

  /**
   * Get the material name for a material ID.
   */
  getName(id: number): MaterialName | undefined {
    return MATERIAL_NAMES[id];
  },

  /**
   * Get the hex color for a material ID.
   */
  getColor(id: number): string {
    return MATERIAL_COLORS[id] ?? '#ffffff';
  },

  /**
   * Get total number of materials.
   */
  get count(): number {
    return MATERIAL_NAMES.length;
  },

  /**
   * Get all material names.
   */
  get names(): readonly MaterialName[] {
    return MATERIAL_NAMES;
  },
} as const;

// ============== Shorthand ==============

/**
 * Shorthand for Materials.get() - get material ID by name.
 * @example
 * const grass = mat('moss2');
 */
export const mat = Materials.get;

// ============== Material Type Constants ==============

/** Numeric material type for fast lookup in hot paths (mesh generation) */
export const MAT_TYPE_SOLID = 0;
export const MAT_TYPE_TRANSPARENT = 1;
export const MAT_TYPE_LIQUID = 2;

export type MaterialTypeNum = typeof MAT_TYPE_SOLID | typeof MAT_TYPE_TRANSPARENT | typeof MAT_TYPE_LIQUID;

// ============== Material Type LUT (Fast Lookup) ==============

/**
 * Material type lookup table.
 * Index by material ID (0-based), value is material type (0=solid, 1=transparent, 2=liquid).
 * 128 bytes fits in L1 cache for fast access in mesh generation hot path.
 */
export const MATERIAL_TYPE_LUT = new Uint8Array(128);

// Initialize LUT from pallet.json
for (const id of pallet.types.transparent) {
  MATERIAL_TYPE_LUT[id] = MAT_TYPE_TRANSPARENT;
}
for (const id of pallet.types.liquid) {
  MATERIAL_TYPE_LUT[id] = MAT_TYPE_LIQUID;
}
// Solid is default (0), no need to explicitly set

/**
 * Get material type as numeric constant (fast, for mesh generation).
 * @example
 * if (getMaterialTypeNum(matId) === MAT_TYPE_TRANSPARENT) { ... }
 */
export function getMaterialTypeNum(id: number): MaterialTypeNum {
  return MATERIAL_TYPE_LUT[id] as MaterialTypeNum;
}

// ============== Material Type Utilities (Set-based for flexibility) ==============

const liquidIds = new Set(pallet.types.liquid);
const transparentIds = new Set(pallet.types.transparent);

/**
 * Check if a material is liquid (water, lava).
 */
export function isLiquid(id: number): boolean {
  return liquidIds.has(id);
}

/**
 * Check if a material is transparent (leaves).
 */
export function isTransparent(id: number): boolean {
  return transparentIds.has(id);
}

/**
 * Check if a material is solid (not liquid or transparent).
 */
export function isSolid(id: number): boolean {
  return !isLiquid(id) && !isTransparent(id);
}

/**
 * Get the material type as a string.
 */
export function getMaterialType(id: number): MaterialType {
  if (isLiquid(id)) return 'liquid';
  if (isTransparent(id)) return 'transparent';
  return 'solid';
}
