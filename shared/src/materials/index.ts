/**
 * Materials module - type-safe material definitions
 */

export {
  // Types
  type MaterialName,
  type MaterialType,
  // Main API
  Materials,
  mat,
  // Raw data
  MATERIAL_IDS,
  MATERIAL_NAMES,
  MATERIAL_COLORS,
  // Type utilities
  isLiquid,
  isTransparent,
  isSolid,
  getMaterialType,
} from './Materials.js';
