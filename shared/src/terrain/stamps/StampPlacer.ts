/**
 * Applies stamp voxels to chunk data
 * Handles placement at terrain height and blending with existing terrain
 */

import { CHUNK_SIZE, VOXEL_SCALE } from '../../voxel/constants.js';
import { packVoxel, getWeight, voxelIndex } from '../../voxel/voxelData.js';
import { getStamp, getStampVoxelsByY, hashInt2, isBuildingStamp } from './StampDefinitions.js';
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
  blendMode: BlendMode.REPLACE_SOLID,
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
   * @param data - Chunk voxel data (CHUNK_SIZE^3 Uint32Array)
   * @param cx - Chunk X coordinate
   * @param cy - Chunk Y coordinate
   * @param cz - Chunk Z coordinate
   * @param placements - Stamp placements to apply
   * @param heightSampler - Function to get terrain height
   */
  applyStamps(
    data: Uint32Array,
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

    // Sort placements so buildings are applied last
    // This ensures their interior carving voxels remove any overlapping trees/rocks
    const sortedPlacements = [...placements].sort((a, b) => {
      const aIsBuilding = isBuildingStamp(a.type);
      const bIsBuilding = isBuildingStamp(b.type);
      if (aIsBuilding && !bIsBuilding) return 1;  // a after b
      if (!aIsBuilding && bIsBuilding) return -1; // a before b
      return 0;
    });

    for (const placement of sortedPlacements) {
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
    data: Uint32Array,
    placement: StampPlacement,
    chunkVoxelX: number,
    chunkVoxelY: number,
    chunkVoxelZ: number,
    heightSampler: HeightSampler
  ): void {
    // Deterministic per-building seed from world position (stable across chunks) → decorations.
    const seed = hashInt2(
      Math.floor(placement.worldX / VOXEL_SCALE),
      Math.floor(placement.worldZ / VOXEL_SCALE),
    );
    // Pass rotation + seed to getStamp for buildings (SDF-based rotation)
    const stamp = getStamp(placement.type, placement.variant, placement.rotation, seed);

    // Get terrain height at stamp position
    const terrainHeight = heightSampler.sampleHeight(placement.worldX, placement.worldZ);

    // Stamp origin in voxel coordinates (yOffset seats e.g. a torch on top of a wall)
    const stampOriginX = Math.floor(placement.worldX / VOXEL_SCALE);
    const stampOriginY = Math.floor(terrainHeight) + (placement.yOffset ?? 0);
    const stampOriginZ = Math.floor(placement.worldZ / VOXEL_SCALE);

    // Only this chunk's Y-slice of the stamp can write here — a tall stamp spans several chunks, so
    // iterating its full voxel list per chunk re-scans the ~(spanned chunks − 1)/spanned that miss.
    // Voxels are Y-sorted (cached on the stamp); binary-search the [loY, hiY) window and iterate just it.
    const f = getStampVoxelsByY(stamp);
    const ys = f.ys, xs = f.xs, zs = f.zs, mats = f.mats, weights = f.weights;
    const loY = chunkVoxelY - stampOriginY;          // inclusive local-Y of this chunk's bottom
    let a = 0, b = f.n;
    while (a < b) { const m = (a + b) >> 1; if (ys[m] < loY) a = m + 1; else b = m; }

    // Flat typed-array loop — contiguous reads instead of a pointer + 5 property loads per voxel.
    const baseX = stampOriginX - chunkVoxelX, baseZ = stampOriginZ - chunkVoxelZ;
    for (let i = a; i < f.n; i++) {
      const localY = ys[i] - loY;                     // = stampOriginY + voxel.y - chunkVoxelY
      if (localY >= CHUNK_SIZE) break;                // past this chunk's Y-window (sorted → done)

      const localX = baseX + xs[i];
      const localZ = baseZ + zs[i];
      if (localX < 0 || localX >= CHUNK_SIZE ||
          localZ < 0 || localZ >= CHUNK_SIZE) {
        continue;
      }

      const index = voxelIndex(localX, localY, localZ);
      const newVoxel = this.blendVoxel(data[index], mats[i], weights[i]);
      if (newVoxel !== null) {
        data[index] = newVoxel;
      }
    }
  }

  /**
   * Blend a stamp voxel with existing chunk voxel
   * @returns New packed voxel value, or null if no change
   */
  private blendVoxel(existing: number, material: number, weight: number): number | null {
    const existingWeight = getWeight(existing);

    // Air voxels (negative weight, material 0) always carve out space
    // This is used by buildings to create hollow interiors
    if (material === 0 && weight < 0) {
      // Only carve if existing is solid
      if (existingWeight > weight) {
        return packVoxel(weight, 0, 0);
      }
      return null;
    }

    switch (this.config.blendMode) {
      case BlendMode.MAX_WEIGHT:
        // Only apply if stamp voxel is more solid
        if (weight > existingWeight) {
          return packVoxel(weight, material, 0);
        }
        return null;

      case BlendMode.REPLACE_SOLID:
        // Replace if stamp voxel is solid (weight > 0)
        if (weight > 0) {
          return packVoxel(weight, material, 0);
        }
        return null;

      case BlendMode.ADDITIVE:
        // Add weights together, clamped
        const combinedWeight = Math.min(0.5, existingWeight + weight);
        // Use stamp material if it's making things more solid
        if (weight > 0) {
          return packVoxel(combinedWeight, material, 0);
        }
        return null;

      default:
        return null;
    }
  }
}
