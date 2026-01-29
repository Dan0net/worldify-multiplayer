/**
 * Terrain generation framework
 * Generates chunk voxel data using layered noise functions
 */

import { SimplexNoise } from './SimplexNoise.js';
import { CHUNK_SIZE, VOXEL_SCALE } from '../voxel/constants.js';
import { packVoxel } from '../voxel/voxelData.js';

// ============== Configuration Types ==============

export interface NoiseLayerConfig {
  /** Frequency of the noise (higher = more detail, smaller features) */
  frequency: number;
  /** Amplitude of the noise (height contribution) */
  amplitude: number;
  /** Number of octaves for fractal noise */
  octaves: number;
  /** Lacunarity - frequency multiplier per octave */
  lacunarity: number;
  /** Persistence - amplitude multiplier per octave */
  persistence: number;
}

export interface TerrainConfig {
  /** Seed for reproducible generation */
  seed: number;
  /** Base height of the terrain in voxels */
  baseHeight: number;
  /** Noise layers for height generation */
  heightLayers: NoiseLayerConfig[];
  /** Default material ID for terrain */
  defaultMaterial: number;
}

// ============== Default Configuration ==============

export const DEFAULT_TERRAIN_CONFIG: TerrainConfig = {
  seed: 12345,
  baseHeight: -16, // Base height in voxels (so surface appears in cy=-1)
  heightLayers: [
    {
      frequency: 0.02,   // Low frequency for broad hills
      amplitude: 16,     // 16 voxels of height variation
      octaves: 1,        // Single octave to start
      lacunarity: 2.0,
      persistence: 0.5,
    },
  ],
  defaultMaterial: 1, // Default terrain material
};

// ============== Terrain Generator ==============

export class TerrainGenerator {
  private config: TerrainConfig;
  private noise: SimplexNoise;

  constructor(config: Partial<TerrainConfig> = {}) {
    this.config = { ...DEFAULT_TERRAIN_CONFIG, ...config };
    
    // Merge height layers if provided
    if (config.heightLayers) {
      this.config.heightLayers = config.heightLayers;
    }
    
    this.noise = new SimplexNoise(this.config.seed);
  }

  /**
   * Update the generator configuration
   */
  setConfig(config: Partial<TerrainConfig>): void {
    this.config = { ...this.config, ...config };
    
    if (config.heightLayers) {
      this.config.heightLayers = config.heightLayers;
    }
    
    if (config.seed !== undefined) {
      this.noise.seed(config.seed);
    }
  }

  /**
   * Get the current configuration
   */
  getConfig(): TerrainConfig {
    return { ...this.config };
  }

  /**
   * Sample terrain height at a world position
   * @param worldX - World X coordinate in meters
   * @param worldZ - World Z coordinate in meters
   * @returns Height in voxels
   */
  sampleHeight(worldX: number, worldZ: number): number {
    let height = this.config.baseHeight;

    for (const layer of this.config.heightLayers) {
      height += this.sampleNoiseLayer(worldX, worldZ, layer);
    }

    return height;
  }

  /**
   * Sample a single noise layer with octave support
   */
  private sampleNoiseLayer(worldX: number, worldZ: number, layer: NoiseLayerConfig): number {
    let value = 0;
    let frequency = layer.frequency;
    let amplitude = layer.amplitude;
    let maxAmplitude = 0;

    for (let o = 0; o < layer.octaves; o++) {
      value += this.noise.noise2D(worldX * frequency, worldZ * frequency) * amplitude;
      maxAmplitude += amplitude;
      frequency *= layer.lacunarity;
      amplitude *= layer.persistence;
    }

    // Normalize by max amplitude to keep values in expected range
    return (value / maxAmplitude) * layer.amplitude;
  }

  /**
   * Generate voxel data for a chunk
   * @param cx - Chunk X coordinate
   * @param cy - Chunk Y coordinate  
   * @param cz - Chunk Z coordinate
   * @returns Uint16Array of packed voxel data (CHUNK_SIZE^3 elements)
   */
  generateChunk(cx: number, cy: number, cz: number): Uint16Array {
    const data = new Uint16Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
    
    // Calculate chunk's world origin
    const chunkWorldX = cx * CHUNK_SIZE * VOXEL_SCALE;
    const chunkWorldY = cy * CHUNK_SIZE; // Y is in voxels for height comparison
    const chunkWorldZ = cz * CHUNK_SIZE * VOXEL_SCALE;

    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        // Calculate world position for this column
        const worldX = chunkWorldX + lx * VOXEL_SCALE;
        const worldZ = chunkWorldZ + lz * VOXEL_SCALE;
        
        // Sample terrain height at this XZ position
        const terrainHeight = this.sampleHeight(worldX, worldZ);

        for (let ly = 0; ly < CHUNK_SIZE; ly++) {
          // Calculate voxel's Y position in world voxel space
          const voxelY = chunkWorldY + ly;
          
          // Calculate signed distance from surface
          // Negative = inside terrain, Positive = outside (air)
          const distanceFromSurface = voxelY - terrainHeight;
          
          // Convert to weight (-0.5 = solid, +0.5 = air, 0 = surface)
          // Clamp to [-0.5, 0.5] range
          const weight = Math.max(-0.5, Math.min(0.5, distanceFromSurface * 0.5));
          
          // Determine material (0 for air, default material for solid)
          const material = weight < 0 ? this.config.defaultMaterial : 0;
          
          // Default light level
          const light = 0;
          
          // Pack and store voxel
          const index = lx + ly * CHUNK_SIZE + lz * CHUNK_SIZE * CHUNK_SIZE;
          data[index] = packVoxel(weight, material, light);
        }
      }
    }

    return data;
  }

  /**
   * Check if a chunk would be completely empty (all air)
   * Useful for culling chunks that don't need generation
   */
  isChunkEmpty(cx: number, cy: number, cz: number): boolean {
    const chunkBottomY = cy * CHUNK_SIZE;

    // Sample corners and center to estimate if chunk might contain terrain
    const chunkWorldX = cx * CHUNK_SIZE * VOXEL_SCALE;
    const chunkWorldZ = cz * CHUNK_SIZE * VOXEL_SCALE;
    const chunkSizeWorld = CHUNK_SIZE * VOXEL_SCALE;

    const samples = [
      this.sampleHeight(chunkWorldX, chunkWorldZ),
      this.sampleHeight(chunkWorldX + chunkSizeWorld, chunkWorldZ),
      this.sampleHeight(chunkWorldX, chunkWorldZ + chunkSizeWorld),
      this.sampleHeight(chunkWorldX + chunkSizeWorld, chunkWorldZ + chunkSizeWorld),
      this.sampleHeight(chunkWorldX + chunkSizeWorld * 0.5, chunkWorldZ + chunkSizeWorld * 0.5),
    ];

    const maxHeight = Math.max(...samples);
    
    // If the max sampled height is below the chunk, it's empty
    return maxHeight < chunkBottomY;
  }

  /**
   * Check if a chunk would be completely solid
   * Useful for optimization
   */
  isChunkSolid(cx: number, cy: number, cz: number): boolean {
    const chunkTopY = (cy + 1) * CHUNK_SIZE;

    const chunkWorldX = cx * CHUNK_SIZE * VOXEL_SCALE;
    const chunkWorldZ = cz * CHUNK_SIZE * VOXEL_SCALE;
    const chunkSizeWorld = CHUNK_SIZE * VOXEL_SCALE;

    const samples = [
      this.sampleHeight(chunkWorldX, chunkWorldZ),
      this.sampleHeight(chunkWorldX + chunkSizeWorld, chunkWorldZ),
      this.sampleHeight(chunkWorldX, chunkWorldZ + chunkSizeWorld),
      this.sampleHeight(chunkWorldX + chunkSizeWorld, chunkWorldZ + chunkSizeWorld),
      this.sampleHeight(chunkWorldX + chunkSizeWorld * 0.5, chunkWorldZ + chunkSizeWorld * 0.5),
    ];

    const minHeight = Math.min(...samples);
    
    // If the min sampled height is above the chunk top, it's solid
    return minHeight > chunkTopY;
  }
}
