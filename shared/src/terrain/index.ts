/**
 * Terrain generation module exports
 */

export { 
  TerrainGenerator, 
  DEFAULT_TERRAIN_CONFIG,
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
} from './stamps/index.js';
