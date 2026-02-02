/**
 * MaterialPallet - Material manifest from shared package
 * 
 * Uses the embedded pallet.json from @worldify/shared.
 * No network requests needed - material data is bundled at build time.
 * 
 * NOTE: For material lookups by name/id, use the Materials API from @worldify/shared:
 *   - Materials.get(name) / mat(name) - Get ID by name
 *   - Materials.getName(id) - Get name by ID
 *   - Materials.getColor(id) - Get hex color by ID
 *   - isLiquid(id), isTransparent(id), isSolid(id) - Type checks
 * 
 * This module only provides access to texture map metadata for loading binaries.
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
 * Use this for texture map metadata (dimensions, channels, layers).
 */
export function getMaterialPallet(): MaterialPallet {
  return materialPallet;
}
