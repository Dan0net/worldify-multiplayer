/**
 * Generates stamp placement points using grid-based distribution with jitter
 * Points are deterministic based on world position and seed
 */

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
  /** Priority order - lower = generated first, claims space (rocks before trees) */
  priority: number;
  /** Grid cell size in meters - one stamp per cell */
  gridSize: number;
  /** Jitter amount as fraction of grid size (0-0.5, e.g., 0.4 = ±40% from center) */
  jitter: number;
  /** Exclusion radius - minimum distance from ANY other stamp (in meters) */
  exclusionRadius: number;
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
    // Buildings generated first (priority -10 to -5) - they claim the most space
    {
      type: StampType.BUILDING_SMALL,
      priority: -10,
      gridSize: 50,           // Very sparse - one per 80m grid cell
      jitter: 0.35,           // Some jitter but not too much
      exclusionRadius: 20,    // 20m exclusion - large clearance around buildings
    },
    {
      type: StampType.BUILDING_HUT,
      priority: -5,
      gridSize: 30,           // Slightly denser than small buildings
      jitter: 0.4,
      exclusionRadius: 15,    // 15m exclusion - huts need clearance too
    },
    // Rocks generated after buildings (priority 0-2) - they claim space
    {
      type: StampType.ROCK_LARGE,
      priority: 0,
      gridSize: 24,           // Large grid = sparse placement
      jitter: 0.4,            // ±40% jitter from cell center
      exclusionRadius: 1,     // 1m exclusion from other stamps
    },
    {
      type: StampType.ROCK_MEDIUM,
      priority: 1,
      gridSize: 10,           // Medium grid
      jitter: 0.4,
      exclusionRadius: 0,
    },
    {
      type: StampType.ROCK_SMALL,
      priority: 2,
      gridSize: 6,            // Smaller grid = denser
      jitter: 0.35,
      exclusionRadius: 0,     // No exclusion - can be close to others
    },
    // Trees generated after rocks (priority 10-11)
    {
      type: StampType.TREE_OAK,
      priority: 10,
      gridSize: 7,
      jitter: 0.4,
      exclusionRadius: 0,
    },
    {
      type: StampType.TREE_PINE,
      priority: 11,
      gridSize: 6,
      jitter: 0.4,
      exclusionRadius: 0,
    },
  ],
};

// ============== Point Generator ==============

export class StampPointGenerator {
  private config: StampDistributionConfig;

  constructor(config: Partial<StampDistributionConfig> = {}) {
    this.config = { ...DEFAULT_STAMP_DISTRIBUTION, ...config };
    if (config.distributions) {
      this.config.distributions = config.distributions;
    }
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
   * Uses fixed grid per stamp type with jitter, processes in priority order
   */
  private generateChunkPoints(cx: number, cz: number): StampPlacement[] {
    const placements: StampPlacement[] = [];
    const chunkWorldX = cx * CHUNK_WORLD_SIZE;
    const chunkWorldZ = cz * CHUNK_WORLD_SIZE;
    
    // Sort distributions by priority (lower = first)
    const sortedDists = [...this.config.distributions].sort((a, b) => a.priority - b.priority);
    
    for (const dist of sortedDists) {
      // Generate grid cells that overlap this chunk
      const gridCells = this.getGridCellsForChunk(cx, cz, dist.gridSize);
      
      for (const cell of gridCells) {
        // Deterministic random for this cell
        const cellSeed = this.hashGridCell(cell.gx, cell.gz, dist.type);
        const rand = this.seededRandom(cellSeed);
        
        // Calculate cell centroid in world space
        const cellCenterX = (cell.gx + 0.5) * dist.gridSize;
        const cellCenterZ = (cell.gz + 0.5) * dist.gridSize;
        
        // Apply jitter (±jitter% from center)
        const maxJitter = dist.gridSize * dist.jitter;
        const jitterX = (rand() * 2 - 1) * maxJitter;
        const jitterZ = (rand() * 2 - 1) * maxJitter;
        
        const worldX = cellCenterX + jitterX;
        const worldZ = cellCenterZ + jitterZ;
        
        // Skip if outside this chunk (will be handled by that chunk)
        if (worldX < chunkWorldX || worldX >= chunkWorldX + CHUNK_WORLD_SIZE ||
            worldZ < chunkWorldZ || worldZ >= chunkWorldZ + CHUNK_WORLD_SIZE) {
          continue;
        }
        
        // Check collision with existing placements
        if (!this.isValidPlacement(worldX, worldZ, dist, placements)) {
          continue;
        }
        
        // Select variant (0-3)
        const variant = Math.floor(rand() * 4);
        
        placements.push({
          type: dist.type,
          variant,
          worldX,
          worldZ,
          rotation: rand() * Math.PI * 2,
        });
      }
    }
    
    return placements;
  }

  /**
   * Get all grid cells that could place a stamp in or near this chunk
   */
  private getGridCellsForChunk(cx: number, cz: number, gridSize: number): Array<{gx: number, gz: number}> {
    const chunkWorldX = cx * CHUNK_WORLD_SIZE;
    const chunkWorldZ = cz * CHUNK_WORLD_SIZE;
    
    // Find grid cell range that could affect this chunk (with 1 cell margin for jitter)
    const minGx = Math.floor((chunkWorldX - gridSize) / gridSize);
    const maxGx = Math.floor((chunkWorldX + CHUNK_WORLD_SIZE + gridSize) / gridSize);
    const minGz = Math.floor((chunkWorldZ - gridSize) / gridSize);
    const maxGz = Math.floor((chunkWorldZ + CHUNK_WORLD_SIZE + gridSize) / gridSize);
    
    const cells: Array<{gx: number, gz: number}> = [];
    for (let gz = minGz; gz <= maxGz; gz++) {
      for (let gx = minGx; gx <= maxGx; gx++) {
        cells.push({ gx, gz });
      }
    }
    return cells;
  }
  
  /**
   * Check if a placement is valid (not too close to existing stamps)
   * Grid spacing handles same-type collision, this checks cross-type exclusion
   */
  private isValidPlacement(
    worldX: number,
    worldZ: number,
    dist: StampDistribution,
    existingPlacements: StampPlacement[]
  ): boolean {
    const exclusionRadius = dist.exclusionRadius;
    
    for (const existing of existingPlacements) {
      const dx = worldX - existing.worldX;
      const dz = worldZ - existing.worldZ;
      const distSq = dx * dx + dz * dz;
      
      // Check cross-type exclusion
      // Use the larger of the two exclusion radii
      const existingDist = this.config.distributions.find(d => d.type === existing.type);
      const existingExclusion = existingDist?.exclusionRadius ?? 0;
      const combinedExclusion = Math.max(exclusionRadius, existingExclusion);
      
      // Skip if neither has exclusion
      if (combinedExclusion <= 0) continue;
      
      if (distSq < combinedExclusion * combinedExclusion) {
        return false;
      }
    }
    
    return true;
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
   * Hash for global grid cell (not chunk-relative)
   */
  private hashGridCell(gx: number, gz: number, type: StampType): number {
    let hash = this.config.seed;
    hash = hash * 31 + gx;
    hash = hash * 31 + gz;
    // Use first char code of type for differentiation
    hash = hash * 31 + type.charCodeAt(0);
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
