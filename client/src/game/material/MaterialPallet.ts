/**
 * MaterialPallet - Material manifest loader
 * 
 * Loads and caches the pallet.json manifest from R2.
 */

import { MATERIAL_BASE_URL } from './constants.js';

export interface MapMetadata {
  width: number;
  height: number;
  channels: string;
  layers: number;
}

export interface MaterialPallet {
  materials: string[];
  maps: {
    low: Record<string, MapMetadata>;
    high: Record<string, MapMetadata>;
  };
  indicies: Record<string, number>;
  types: {
    solid: number[];
    liquid: number[];
    transparent: number[];
  };
  colors: string[];
}

let cachedPallet: MaterialPallet | null = null;

/**
 * Fetch the material pallet manifest.
 * Caches the result for subsequent calls.
 */
export async function getMaterialPallet(): Promise<MaterialPallet> {
  if (cachedPallet) {
    return cachedPallet;
  }

  const response = await fetch(`${MATERIAL_BASE_URL}/pallet.json`);
  if (!response.ok) {
    throw new Error(`Failed to fetch material pallet: ${response.status}`);
  }

  cachedPallet = await response.json();
  return cachedPallet!;
}

/**
 * Get the material index for a material name.
 */
export function getMaterialIndex(pallet: MaterialPallet, name: string): number {
  return pallet.indicies[name] ?? 0;
}

/**
 * Get the material name for a material index.
 */
export function getMaterialName(pallet: MaterialPallet, index: number): string {
  return pallet.materials[index] ?? 'unknown';
}

/**
 * Get the average color for a material index (as hex string).
 */
export function getMaterialColorHex(pallet: MaterialPallet, index: number): string {
  return pallet.colors[index] ?? '#ffffff';
}

/**
 * Check if a material is transparent.
 */
export function isMaterialTransparent(pallet: MaterialPallet, index: number): boolean {
  return pallet.types.transparent.includes(index + 1); // types use 1-based indices
}

/**
 * Check if a material is liquid.
 */
export function isMaterialLiquid(pallet: MaterialPallet, index: number): boolean {
  return pallet.types.liquid.includes(index + 1);
}

/**
 * Clear the cached pallet (useful for testing or reloading).
 */
export function clearPalletCache(): void {
  cachedPallet = null;
}
