/**
 * Stamp system exports - procedural terrain features (trees, rocks)
 */

export {
  StampType,
  type StampDefinition,
  type StampVoxel,
  getStamp,
  getVariantCount,
  getAllStampTypes,
  isRotatableStamp,
  // Material constants
  MAT_BARK,
  MAT_BARK_DARK,
  MAT_LEAVES,
  MAT_LEAVES2,
  MAT_ROCK,
  MAT_ROCK2,
  MAT_ROCK_MOSS,
} from './StampDefinitions.js';

export {
  StampPointGenerator,
  type StampDistributionConfig,
  type StampDistribution,
  type StampPlacement,
  DEFAULT_STAMP_DISTRIBUTION,
} from './StampPointGenerator.js';

export {
  StampPlacer,
  BlendMode,
  type StampPlacerConfig,
  type HeightSampler,
} from './StampPlacer.js';
