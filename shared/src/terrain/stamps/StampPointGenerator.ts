/**
 * Generates stamp placement points using noise-based distribution
 * Points are deterministic based on world position and seed
 */

import FastNoiseLite from 'fastnoise-lite';
import { CHUNK_SIZE, CHUNK_WORLD_SIZE, VOXEL_SCALE } from '../../voxel/constants.js';
import { StampType, getStamp } from './StampDefinitions.js';

// ============== Configuration ==============

export interface StampDistributionConfig {
  /** Seed for reproducible generation */
  seed: number;
  /** Stamp types to generate with their weights */
  distributions: StampDistribution[];
}

export interface StampDistribution {
  /** Which stamp type to place */
  type: StampType;
  /** Base density (stamps per chunk on average) */
  density: number;
  /** Minimum spacing between stamps of this type (in voxels) */
  minSpacing: number;
  /** Noise frequency for density variation (0 = uniform) */
  densityNoiseFreq: number;
  /** How much noise affects density (0-1) */
  densityNoiseAmp: number;
}

export interface StampPlacement {
  /** Stamp type */
  type: StampType;
  /** Variant index */
  variant: number;
  /** World X position (meters) */
  worldX: number;
  /** World Z position (meters) */
  worldZ: number;
  /** Rotation in radians (for future use) */
  rotation: number;
}

// ============== Default Configuration ==============

export const DEFAULT_STAMP_DISTRIBUTION: StampDistributionConfig = {
  seed: 54321,
  distributions: [
    {
      type: StampType.TREE_PINE,
      density: 2.0,           // ~2 per chunk
      minSpacing: 8,          // 2m minimum spacing
      densityNoiseFreq: 0.02,
      densityNoiseAmp: 0.8,   // Creates forest/clearing patterns
    },
    {
      type: StampType.TREE_OAK,
      density: 1.0,
      minSpacing: 10,
      densityNoiseFreq: 0.015,
      densityNoiseAmp: 0.9,
    },
    {
      type: StampType.ROCK_SMALL,
      density: 3.0,
      minSpacing: 4,
      densityNoiseFreq: 0.05,
      densityNoiseAmp: 0.6,
    },
    {
      type: StampType.ROCK_MEDIUM,
      density: 1.0,
      minSpacing: 8,
      densityNoiseFreq: 0.03,
      densityNoiseAmp: 0.7,
    },
    {
      type: StampType.ROCK_LARGE,
      density: 0.3,
      minSpacing: 16,
      densityNoiseFreq: 0.02,
      densityNoiseAmp: 0.8,
    },
  ],
};

// ============== Point Generator ==============

export class StampPointGenerator {
  private config: StampDistributionConfig;
  private densityNoise: FastNoiseLite;
  private positionNoise: FastNoiseLite;
  private variantNoise: FastNoiseLite;

  constructor(config: Partial<StampDistributionConfig> = {}) {
    this.config = { ...DEFAULT_STAMP_DISTRIBUTION, ...config };
    if (config.distributions) {
      this.config.distributions = config.distributions;
    }

    let seed = this.config.seed;
    
    // Noise for density variation
    this.densityNoise = new FastNoiseLite(seed++);
    this.densityNoise.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    
    // Noise for jittering point positions  
    this.positionNoise = new FastNoiseLite(seed++);
    this.positionNoise.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    
    // Noise for variant selection
    this.variantNoise = new FastNoiseLite(seed++);
    this.variantNoise.SetNoiseType(FastNoiseLite.NoiseType.Value);
  }

  /**
   * Get seed for configuration
   */
  getSeed(): number {
    return this.config.seed;
  }

  /**
   * Generate stamp placements for a chunk and its neighbors that may overlap
   * @param cx - Chunk X coordinate
   * @param cz - Chunk Z coordinate  
   * @param margin - Extra margin in voxels to check for overlapping stamps
   * @returns Array of stamp placements
   */
  generateForChunk(cx: number, cz: number, margin: number = 16): StampPlacement[] {
    const placements: StampPlacement[] = [];
    
    // Check neighboring chunks that might have stamps overlapping into this chunk
    const chunkMargin = Math.ceil(margin / CHUNK_SIZE) + 1;
    
    for (let dz = -chunkMargin; dz <= chunkMargin; dz++) {
      for (let dx = -chunkMargin; dx <= chunkMargin; dx++) {
        const neighborCx = cx + dx;
        const neighborCz = cz + dz;
        
        // Generate points for this neighbor chunk
        const neighborPlacements = this.generateChunkPoints(neighborCx, neighborCz);
        
        // Filter to only include placements that affect the target chunk
        for (const placement of neighborPlacements) {
          if (this.stampAffectsChunk(placement, cx, cz, margin)) {
            placements.push(placement);
          }
        }
      }
    }
    
    return placements;
  }

  /**
   * Generate raw stamp points within a single chunk (no neighbor check)
   */
  private generateChunkPoints(cx: number, cz: number): StampPlacement[] {
    const placements: StampPlacement[] = [];
    const chunkWorldX = cx * CHUNK_WORLD_SIZE;
    const chunkWorldZ = cz * CHUNK_WORLD_SIZE;
    
    for (const dist of this.config.distributions) {
      // Sample density at chunk center
      const centerX = chunkWorldX + CHUNK_WORLD_SIZE / 2;
      const centerZ = chunkWorldZ + CHUNK_WORLD_SIZE / 2;
      
      let density = dist.density;
      if (dist.densityNoiseFreq > 0) {
        const noiseVal = this.densityNoise.GetNoise(
          centerX * dist.densityNoiseFreq,
          centerZ * dist.densityNoiseFreq
        );
        // Map noise from [-1,1] to density multiplier
        density *= 1 + noiseVal * dist.densityNoiseAmp;
        density = Math.max(0, density);
      }
      
      // Generate points using stratified sampling with jitter
      const gridSize = Math.max(1, Math.floor(Math.sqrt(density * 2)));
      const cellSize = CHUNK_WORLD_SIZE / gridSize;
      
      for (let gz = 0; gz < gridSize; gz++) {
        for (let gx = 0; gx < gridSize; gx++) {
          // Deterministic random for this cell
          const cellSeed = this.hashCell(cx, cz, gx, gz, dist.type);
          const rand = this.seededRandom(cellSeed);
          
          // Probability check based on density
          const cellDensity = density / (gridSize * gridSize);
          if (rand() > cellDensity) continue;
          
          // Jitter position within cell
          const jitterX = rand() * cellSize;
          const jitterZ = rand() * cellSize;
          
          const worldX = chunkWorldX + gx * cellSize + jitterX;
          const worldZ = chunkWorldZ + gz * cellSize + jitterZ;
          
          // Select variant based on position
          const variantNoise = this.variantNoise.GetNoise(worldX * 100, worldZ * 100);
          const variant = Math.floor((variantNoise + 1) * 2) % 4;
          
          placements.push({
            type: dist.type,
            variant,
            worldX,
            worldZ,
            rotation: rand() * Math.PI * 2,
          });
        }
      }
    }
    
    return placements;
  }

  /**
   * Check if a stamp placement affects a chunk (considering stamp bounds)
   */
  private stampAffectsChunk(
    placement: StampPlacement,
    cx: number,
    cz: number,
    margin: number
  ): boolean {
    const stamp = getStamp(placement.type, placement.variant);
    const bounds = stamp.bounds;
    
    // Convert placement to voxel coordinates
    const stampVoxelX = placement.worldX / VOXEL_SCALE;
    const stampVoxelZ = placement.worldZ / VOXEL_SCALE;
    
    // Chunk bounds in voxels
    const chunkMinVoxelX = cx * CHUNK_SIZE;
    const chunkMinVoxelZ = cz * CHUNK_SIZE;
    const chunkMaxVoxelX = chunkMinVoxelX + CHUNK_SIZE;
    const chunkMaxVoxelZ = chunkMinVoxelZ + CHUNK_SIZE;
    
    // Stamp bounds in world voxels
    const stampMinX = stampVoxelX + bounds.minX;
    const stampMaxX = stampVoxelX + bounds.maxX;
    const stampMinZ = stampVoxelZ + bounds.minZ;
    const stampMaxZ = stampVoxelZ + bounds.maxZ;
    
    // Check overlap with margin
    return stampMaxX >= chunkMinVoxelX - margin &&
           stampMinX <= chunkMaxVoxelX + margin &&
           stampMaxZ >= chunkMinVoxelZ - margin &&
           stampMinZ <= chunkMaxVoxelZ + margin;
  }

  /**
   * Simple hash for cell coordinates
   */
  private hashCell(cx: number, cz: number, gx: number, gz: number, type: StampType): number {
    let hash = this.config.seed;
    hash = hash * 31 + cx;
    hash = hash * 31 + cz;
    hash = hash * 31 + gx;
    hash = hash * 31 + gz;
    hash = hash * 31 + type.length;
    return hash >>> 0;
  }

  /**
   * Seeded random number generator
   */
  private seededRandom(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) >>> 0;
      return (state & 0x7fffffff) / 0x7fffffff;
    };
  }
}
