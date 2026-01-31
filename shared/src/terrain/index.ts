/**
 * Terrain generation module exports
 */

export { 
  TerrainGenerator, 
  DEFAULT_TERRAIN_CONFIG,
  MATERIAL_MOSS2,
  MATERIAL_ROCK,
  MATERIAL_ROCK2,
  type NoiseLayerConfig,
  type DomainWarpConfig,
  type MaterialLayerConfig,
  type TerrainConfig,
} from './TerrainGenerator.js';

// Stamp system re-exports
export {
  StampType,
  StampPointGenerator,
  StampPlacer,
  BlendMode,
  getStamp,
  getVariantCount,
  getAllStampTypes,
  DEFAULT_STAMP_DISTRIBUTION,
  type StampDefinition,
  type StampVoxel,
  type StampDistributionConfig,
  type StampDistribution,
  type StampPlacement,
  type StampPlacerConfig,
  type HeightSampler,
  // Material constants for stamps
  MAT_BARK,
  MAT_BARK_DARK,
  MAT_LEAVES,
  MAT_LEAVES2,
  MAT_ROCK as MAT_STAMP_ROCK,
  MAT_ROCK2 as MAT_STAMP_ROCK2,
  MAT_ROCK_MOSS,
} from './stamps/index.js';
