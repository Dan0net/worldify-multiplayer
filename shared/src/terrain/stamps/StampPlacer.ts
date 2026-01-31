/**
 * Applies stamp voxels to chunk data
 * Handles placement at terrain height and blending with existing terrain
 */

import { CHUNK_SIZE, VOXEL_SCALE } from '../../voxel/constants.js';
import { packVoxel, getWeight, voxelIndex } from '../../voxel/voxelData.js';
import { getStamp, StampVoxel } from './StampDefinitions.js';
import { StampPlacement } from './StampPointGenerator.js';

// ============== Types ==============

export interface StampPlacerConfig {
  /** Blend mode for overlapping voxels */
  blendMode: BlendMode;
}

export enum BlendMode {
  /** New voxel replaces old if more solid */
  MAX_WEIGHT = 'max_weight',
  /** New voxel always wins if it's solid */
  REPLACE_SOLID = 'replace_solid',
  /** Additive blending (combine weights) */
  ADDITIVE = 'additive',
}

// ============== Height Sampler Interface ==============

/**
 * Interface for terrain height sampling
 * Allows stamps to be placed on top of terrain
 */
export interface HeightSampler {
  /**
   * Get terrain height at world XZ position
   * @param worldX - World X in meters
   * @param worldZ - World Z in meters
   * @returns Height in voxels
   */
  sampleHeight(worldX: number, worldZ: number): number;
}

// ============== Stamp Placer ==============

const DEFAULT_CONFIG: StampPlacerConfig = {
  blendMode: BlendMode.MAX_WEIGHT,
};

/**
 * Apply stamps to chunk voxel data
 */
export class StampPlacer {
  private config: StampPlacerConfig;

  constructor(config: Partial<StampPlacerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Apply multiple stamp placements to chunk data
   * Modifies the data array in place
   * 
   * @param data - Chunk voxel data (CHUNK_SIZE^3 Uint16Array)
   * @param cx - Chunk X coordinate
   * @param cy - Chunk Y coordinate
   * @param cz - Chunk Z coordinate
   * @param placements - Stamp placements to apply
   * @param heightSampler - Function to get terrain height
   */
  applyStamps(
    data: Uint16Array,
    cx: number,
    cy: number,
    cz: number,
    placements: StampPlacement[],
    heightSampler: HeightSampler
  ): void {
    // Chunk bounds in voxel space
    const chunkVoxelX = cx * CHUNK_SIZE;
    const chunkVoxelY = cy * CHUNK_SIZE;
    const chunkVoxelZ = cz * CHUNK_SIZE;

    for (const placement of placements) {
      this.applyStamp(
        data,
        placement,
        chunkVoxelX,
        chunkVoxelY,
        chunkVoxelZ,
        heightSampler
      );
    }
  }

  /**
   * Apply a single stamp to chunk data
   */
  private applyStamp(
    data: Uint16Array,
    placement: StampPlacement,
    chunkVoxelX: number,
    chunkVoxelY: number,
    chunkVoxelZ: number,
    heightSampler: HeightSampler
  ): void {
    const stamp = getStamp(placement.type, placement.variant);
    
    // Get terrain height at stamp position
    const terrainHeight = heightSampler.sampleHeight(placement.worldX, placement.worldZ);
    
    // Stamp origin in voxel coordinates
    const stampOriginX = Math.floor(placement.worldX / VOXEL_SCALE);
    const stampOriginY = Math.floor(terrainHeight); // Place on terrain
    const stampOriginZ = Math.floor(placement.worldZ / VOXEL_SCALE);

    for (const voxel of stamp.voxels) {
      // Global voxel position
      const globalX = stampOriginX + voxel.x;
      const globalY = stampOriginY + voxel.y;
      const globalZ = stampOriginZ + voxel.z;
      
      // Convert to local chunk coordinates
      const localX = globalX - chunkVoxelX;
      const localY = globalY - chunkVoxelY;
      const localZ = globalZ - chunkVoxelZ;
      
      // Skip if outside this chunk
      if (localX < 0 || localX >= CHUNK_SIZE ||
          localY < 0 || localY >= CHUNK_SIZE ||
          localZ < 0 || localZ >= CHUNK_SIZE) {
        continue;
      }
      
      // Get existing voxel
      const index = voxelIndex(localX, localY, localZ);
      const existing = data[index];
      
      // Blend based on mode
      const newVoxel = this.blendVoxel(existing, voxel);
      if (newVoxel !== null) {
        data[index] = newVoxel;
      }
    }
  }

  /**
   * Blend a stamp voxel with existing chunk voxel
   * @returns New packed voxel value, or null if no change
   */
  private blendVoxel(existing: number, stamp: StampVoxel): number | null {
    const existingWeight = getWeight(existing);
    
    switch (this.config.blendMode) {
      case BlendMode.MAX_WEIGHT:
        // Only apply if stamp voxel is more solid
        if (stamp.weight > existingWeight) {
          return packVoxel(stamp.weight, stamp.material, 0);
        }
        return null;
        
      case BlendMode.REPLACE_SOLID:
        // Replace if stamp voxel is solid (weight > 0)
        if (stamp.weight > 0) {
          return packVoxel(stamp.weight, stamp.material, 0);
        }
        return null;
        
      case BlendMode.ADDITIVE:
        // Add weights together, clamped
        const combinedWeight = Math.min(0.5, existingWeight + stamp.weight);
        // Use stamp material if it's making things more solid
        if (stamp.weight > 0) {
          return packVoxel(combinedWeight, stamp.material, 0);
        }
        return null;
        
      default:
        return null;
    }
  }
}
