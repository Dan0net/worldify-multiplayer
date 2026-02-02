/**
 * Material definitions and lookup utilities
 *
 * Provides type-safe material name references that map to pallet.json indices.
 * Use material names in code (e.g., 'moss2', 'rock') and look up IDs at runtime.
 */

import pallet from './pallet.json' with { type: 'json' };

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

// ============== Material Type Utilities ==============

// Note: pallet.json types use 1-based indices
const liquidIds = new Set(pallet.types.liquid);
const transparentIds = new Set(pallet.types.transparent);

/**
 * Check if a material is liquid (water, lava).
 */
export function isLiquid(id: number): boolean {
  return liquidIds.has(id + 1); // types use 1-based indices
}

/**
 * Check if a material is transparent (leaves).
 */
export function isTransparent(id: number): boolean {
  return transparentIds.has(id + 1);
}

/**
 * Check if a material is solid (not liquid or transparent).
 */
export function isSolid(id: number): boolean {
  return !isLiquid(id) && !isTransparent(id);
}

/**
 * Get the material type.
 */
export function getMaterialType(id: number): MaterialType {
  if (isLiquid(id)) return 'liquid';
  if (isTransparent(id)) return 'transparent';
  return 'solid';
}
