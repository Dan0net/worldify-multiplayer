/**
 * Materials module - type-safe material definitions
 */

export {
  // Types
  type MaterialName,
  type MaterialType,
  type MaterialTypeNum,
  // Main API
  Materials,
  mat,
  // Raw data
  MATERIAL_IDS,
  MATERIAL_NAMES,
  MATERIAL_COLORS,
  MATERIAL_REPEAT_SCALES,
  MATERIAL_PALLET,
  // Material type constants
  MAT_TYPE_SOLID,
  MAT_TYPE_TRANSPARENT,
  MAT_TYPE_LIQUID,
  MATERIAL_TYPE_LUT,
  MATERIAL_EMISSION_LUT,
  // Type utilities
  isLiquid,
  isTransparent,
  isSolid,
  isVoxelOpaque,
  getMaterialType,
  getMaterialTypeNum,
} from './Materials.js';
