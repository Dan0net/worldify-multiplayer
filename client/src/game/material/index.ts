/**
 * Material system exports
 */

export { textureCache } from './TextureCache.js';
export { 
  getMaterialPallet, 
  type MaterialPallet,
  type MapMetadata,
} from './MaterialPallet.js';
export {
  TerrainMaterial,
  getTerrainMaterial,
  getTransparentTerrainMaterial,
  getLiquidTerrainMaterial,
  initializeMaterials,
  initializePlaceholderTextures,
  upgradeToHighRes,
  isHighResCached,
  loadDataArrayTextures,
  updateWindTime,
  type TextureResolution,
  type LoadedTextures,
} from './TerrainMaterial.js';
export {
  MATERIAL_BASE_URL,
  TERRAIN_MATERIAL_REPEAT_SCALE,
  TERRAIN_MATERIAL_BLEND_OFFSET_RAD,
} from './constants.js';
export { materialManager } from './MaterialManager.js';

// Placeholder texture utilities (for direct use if needed)
export {
  createDefaultPlaceholders,
  createPalletPlaceholders,
  loadPalletPlaceholders,
} from './PlaceholderTextures.js';
