/**
 * MaterialPallet - Material manifest from shared package
 * 
 * Uses the embedded pallet.json from @worldify/shared.
 * No network requests needed - material data is bundled at build time.
 */

import { MATERIAL_PALLET } from '@worldify/shared';

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

// Cast the imported data to our interface
const materialPallet = MATERIAL_PALLET as unknown as MaterialPallet;

/**
 * Get the material pallet manifest (synchronous - embedded at build time).
 */
export function getMaterialPallet(): MaterialPallet {
  return materialPallet;
}

/**
 * Get the material index for a material name.
 */
export function getMaterialIndex(palletData: MaterialPallet, name: string): number {
  return palletData.indicies[name] ?? 0;
}

/**
 * Get the material name for a material index.
 */
export function getMaterialName(palletData: MaterialPallet, index: number): string {
  return palletData.materials[index] ?? 'unknown';
}

/**
 * Get the average color for a material index (as hex string).
 */
export function getMaterialColorHex(palletData: MaterialPallet, index: number): string {
  return palletData.colors[index] ?? '#ffffff';
}

/**
 * Check if a material is transparent.
 */
export function isMaterialTransparent(palletData: MaterialPallet, index: number): boolean {
  return palletData.types.transparent.includes(index + 1); // types use 1-based indices
}

/**
 * Check if a material is liquid.
 */
export function isMaterialLiquid(palletData: MaterialPallet, index: number): boolean {
  return palletData.types.liquid.includes(index + 1);
}
