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
