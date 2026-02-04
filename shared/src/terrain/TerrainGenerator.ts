/**
 * Terrain generation framework
 * Generates chunk voxel data using layered noise functions with domain warping
 */

import FastNoiseLite from 'fastnoise-lite';
import { CHUNK_SIZE, VOXEL_SCALE } from '../voxel/constants.js';
import { packVoxel } from '../voxel/voxelData.js';
import { mat } from '../materials/index.js';
import { smoothstep } from '../util/math.js';
import {
  StampPointGenerator,
  StampPlacer,
  type StampDistributionConfig,
  type HeightSampler,
} from './stamps/index.js';

// ============== Configuration Types ==============

export interface NoiseLayerConfig {
  /** Frequency of the noise (higher = more detail, smaller features) */
  frequency: number;
  /** Amplitude of the noise (height contribution in voxels) */
  amplitude: number;
  /** Number of octaves for fractal noise */
  octaves: number;
  /** Lacunarity - frequency multiplier per octave */
  lacunarity: number;
  /** Persistence - amplitude multiplier per octave */
  persistence: number;
}

export interface DomainWarpConfig {
  /** Whether domain warping is enabled */
  enabled: boolean;
  /** Frequency of the warp noise */
  frequency: number;
  /** Strength of the warp in world units (meters) */
  amplitude: number;
  /** Number of octaves for warp noise */
  octaves: number;
}

export interface MaterialLayerConfig {
  /** Material ID to use */
  materialId: number;
  /** Maximum depth from surface where this material appears (in voxels) */
  maxDepth: number;
}

export interface PathwayConfig {
  /** Enable pathway generation */
  enabled: boolean;
  /** Material IDs for pathways - selected via noise */
  materials: number[];
  /** Frequency for material selection noise (lower = materials change less frequently) */
  materialNoiseFrequency: number;
  /** Frequency of the cellular noise (lower = larger cells, sparser paths) */
  frequency: number;
  /** Path width in world units (meters) - how far to sample for edge detection */
  pathWidth: number;
  /** Maximum depth from surface where pathway material appears (in voxels) */
  maxDepth: number;
  /** Domain warp frequency for organic curves */
  warpFrequency: number;
  /** Domain warp amplitude in world units */
  warpAmplitude: number;
  /** Wall height in voxels for cobble paths (0 to disable) */
  wallHeight: number;
  /** Wall material ID */
  wallMaterial: number;
  /** Materials that should have walls */
  wallMaterials: number[];
  /** Depth to dip the path in the middle (in voxels) */
  dipDepth: number;
  /** Border width in meters along path edges (where no wall) */
  borderWidth: number;
  /** Border material ID */
  borderMaterial: number;
  /** Enable water in pathway dips */
  waterEnabled: boolean;
  /** Water material ID */
  waterMaterial: number;
  /** Water depth in voxels (how deep the water fills the dip, 0 = full dip) */
  waterDepth: number;
}

export interface TerrainConfig {
  /** Seed for reproducible generation */
  seed: number;
  /** Base height of the terrain in voxels */
  baseHeight: number;
  /** Noise layers for height generation */
  heightLayers: NoiseLayerConfig[];
  /** Domain warp configuration for organic terrain shapes */
  domainWarp: DomainWarpConfig;
  /** Material layers ordered from surface down (first = top layer) */
  materialLayers: MaterialLayerConfig[];
  /** Default/fallback material ID for deep terrain */
  defaultMaterial: number;
  /** Enable stamp generation (trees, rocks) */
  enableStamps: boolean;
  /** Stamp distribution configuration (optional, uses defaults if not provided) */
  stampConfig?: Partial<StampDistributionConfig>;
  /** Pathway generation configuration */
  pathwayConfig: PathwayConfig;
}

// All pathway material options
const PATHWAY_MATERIALS = [
  mat('pebbles'),
  mat('cobble'),
  mat('cobble2'),
  mat('gravel'),
];

// ============== Default Pathway Configuration ==============

export const DEFAULT_PATHWAY_CONFIG: PathwayConfig = {
  enabled: true,
  materials: PATHWAY_MATERIALS,
  materialNoiseFrequency: 0.007, // Low frequency so material doesn't change too often
  frequency: 0.008,         // Large cells = sparse path network
  pathWidth: 3.0,           // Path width in meters
  maxDepth: 2,              // Only surface voxels
  warpFrequency: 0.011,     // Low frequency for smooth curves
  warpAmplitude: 90,        // Strong warping for organic curves
  wallHeight: 5,            // Wall height in voxels
  wallMaterial: mat('brick2'),
  wallMaterials: [mat('cobble'), mat('cobble2')], // Only cobble paths get walls
  dipDepth: 2,              // Path dips 2 voxels in the middle
  borderWidth: 0.4,         // Dirt border width in meters
  borderMaterial: mat('dirt2'),
  waterEnabled: true,       // Fill path dips with water
  waterMaterial: mat('water'),
  waterDepth: -1,           // Water fills 1 voxel above original terrain (negative = above)
};

// ============== Default Configuration ==

export const DEFAULT_TERRAIN_CONFIG: TerrainConfig = {
  seed: 12345,
  baseHeight: 0,
  heightLayers: [
    {
      // Primary hills - broad rolling terrain (~12m wavelength)
      frequency: 0.25,
      amplitude: 20, // ~5m height variation
      octaves: 3,
      lacunarity: 2.0,
      persistence: 0.5,
    },
    {
      // Medium detail - bumps and mounds (~3m wavelength)
      frequency: 4.0,
      amplitude: 2, // ~3m height variation
      octaves: 2,
      lacunarity: 2.0,
      persistence: 0.5,
    }
  ],
  domainWarp: {
    enabled: true,
    frequency: 0.01,
    amplitude: 8,
    octaves: 2,
  },
  materialLayers: [
    { materialId: mat('moss2'), maxDepth: 2 },   // Grass: 0-2 voxels deep
    { materialId: mat('rock'), maxDepth: 8 },    // Rock: 2-8 voxels deep
    { materialId: mat('rock2'), maxDepth: Infinity }, // Stone: 8+ voxels
  ],
  defaultMaterial: mat('rock2'),
  enableStamps: true,
  pathwayConfig: DEFAULT_PATHWAY_CONFIG,
};

// ============== Terrain Generator ==============

export class TerrainGenerator implements HeightSampler {
  private config: TerrainConfig;
  private heightNoise: FastNoiseLite;
  private warpNoiseX: FastNoiseLite;
  private warpNoiseZ: FastNoiseLite;
  
  // Pathway system - cellular noise with domain warping
  private pathwayCellular: FastNoiseLite;
  private pathwayWarpX: FastNoiseLite;
  private pathwayWarpZ: FastNoiseLite;
  private pathwayMaterialNoise: FastNoiseLite;
  
  // Stamp system
  private stampPointGenerator: StampPointGenerator | null = null;
  private stampPlacer: StampPlacer | null = null;

  constructor(config: Partial<TerrainConfig> = {}) {
    this.config = { ...DEFAULT_TERRAIN_CONFIG, ...config };
    
    // Merge height layers if provided
    if (config.heightLayers) {
      this.config.heightLayers = config.heightLayers;
    }
    if (config.materialLayers) {
      this.config.materialLayers = config.materialLayers;
    }
    if (config.domainWarp) {
      this.config.domainWarp = { ...DEFAULT_TERRAIN_CONFIG.domainWarp, ...config.domainWarp };
    }
    if (config.pathwayConfig) {
      this.config.pathwayConfig = { ...DEFAULT_PATHWAY_CONFIG, ...config.pathwayConfig };
    }
    
    // Initialize noise generators
    let seed = this.config.seed;
    
    // Height noise
    this.heightNoise = new FastNoiseLite(seed++);
    this.heightNoise.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    
    // Domain warp noise (separate for X and Z)
    this.warpNoiseX = new FastNoiseLite(seed++);
    this.warpNoiseX.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    this.warpNoiseX.SetFractalType(FastNoiseLite.FractalType.FBm);
    
    this.warpNoiseZ = new FastNoiseLite(seed++);
    this.warpNoiseZ.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    this.warpNoiseZ.SetFractalType(FastNoiseLite.FractalType.FBm);
    
    this.updateWarpConfig();
    
    // Pathway cellular noise - uses CellValue for unique cell IDs, then we detect edges
    this.pathwayCellular = new FastNoiseLite(seed++);
    this.pathwayCellular.SetNoiseType(FastNoiseLite.NoiseType.Cellular);
    this.pathwayCellular.SetCellularReturnType(FastNoiseLite.CellularReturnType.CellValue);
    this.pathwayCellular.SetCellularDistanceFunction(FastNoiseLite.CellularDistanceFunction.EuclideanSq);
    
    // Pathway domain warp noise for organic curved edges
    this.pathwayWarpX = new FastNoiseLite(seed++);
    this.pathwayWarpX.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    this.pathwayWarpX.SetFractalType(FastNoiseLite.FractalType.FBm);
    this.pathwayWarpX.SetFractalOctaves(2);
    
    this.pathwayWarpZ = new FastNoiseLite(seed++);
    this.pathwayWarpZ.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    this.pathwayWarpZ.SetFractalType(FastNoiseLite.FractalType.FBm);
    this.pathwayWarpZ.SetFractalOctaves(2);
    
    // Pathway material selection noise - low frequency for gradual material transitions
    this.pathwayMaterialNoise = new FastNoiseLite(seed++);
    this.pathwayMaterialNoise.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    
    this.updatePathwayConfig();
    
    // Initialize stamp system if enabled
    if (this.config.enableStamps) {
      this.initializeStampSystem();
    }
  }
  
  /**
   * Initialize the stamp generation system
   */
  private initializeStampSystem(): void {
    const stampConfig = {
      seed: this.config.seed + 10000, // Offset seed for stamps
      ...this.config.stampConfig,
    };
    this.stampPointGenerator = new StampPointGenerator(stampConfig);
    this.stampPlacer = new StampPlacer();
  }

  /**
   * Update the generator configuration
   */
  setConfig(config: Partial<TerrainConfig>): void {
    this.config = { ...this.config, ...config };
    
    if (config.heightLayers) {
      this.config.heightLayers = config.heightLayers;
    }
    if (config.materialLayers) {
      this.config.materialLayers = config.materialLayers;
    }
    if (config.domainWarp) {
      this.config.domainWarp = { ...this.config.domainWarp, ...config.domainWarp };
      this.updateWarpConfig();
    }
    
    if (config.seed !== undefined) {
      let seed = config.seed;
      this.heightNoise.SetSeed(seed++);
      this.warpNoiseX.SetSeed(seed++);
      this.warpNoiseZ.SetSeed(seed++);
    }
  }

  /**
   * Update domain warp noise configuration
   */
  private updateWarpConfig(): void {
    const warp = this.config.domainWarp;
    this.warpNoiseX.SetFrequency(warp.frequency);
    this.warpNoiseX.SetFractalOctaves(warp.octaves);
    this.warpNoiseZ.SetFrequency(warp.frequency);
    this.warpNoiseZ.SetFractalOctaves(warp.octaves);
  }

  /**
   * Update pathway noise configuration
   */
  private updatePathwayConfig(): void {
    const path = this.config.pathwayConfig;
    this.pathwayCellular.SetFrequency(path.frequency);
    this.pathwayWarpX.SetFrequency(path.warpFrequency);
    this.pathwayWarpZ.SetFrequency(path.warpFrequency);
    this.pathwayMaterialNoise.SetFrequency(path.materialNoiseFrequency);
  }

  /**
   * Get the pathway material at a world position using noise-based selection
   * @param worldX - World X coordinate in meters
   * @param worldZ - World Z coordinate in meters
   * @returns Material ID for the pathway at this position
   */
  getPathwayMaterial(worldX: number, worldZ: number): number {
    const materials = this.config.pathwayConfig.materials;
    if (materials.length === 0) {
      return mat('pebbles'); // Fallback
    }
    if (materials.length === 1) {
      return materials[0];
    }
    
    // Use noise to select material - noise returns -1 to 1, map to material index
    const noise = this.pathwayMaterialNoise.GetNoise(worldX, worldZ);
    const normalized = (noise + 1) * 0.5; // Map to 0-1
    const index = Math.min(Math.floor(normalized * materials.length), materials.length - 1);
    return materials[index];
  }

  /**
   * Apply domain warping for pathway coordinates
   * @returns Warped [x, z] coordinates
   */
  private applyPathwayWarp(worldX: number, worldZ: number): [number, number] {
    const path = this.config.pathwayConfig;
    const warpX = this.pathwayWarpX.GetNoise(worldX, worldZ) * path.warpAmplitude;
    const warpZ = this.pathwayWarpZ.GetNoise(worldX, worldZ) * path.warpAmplitude;
    return [worldX + warpX, worldZ + warpZ];
  }

  /**
   * Check if a world position is on a pathway
   * Uses cellular noise with CellValue, applies domain warping, then detects edges
   * by comparing cell values at neighboring positions for uniform-width contiguous paths
   * @param worldX - World X coordinate in meters
   * @param worldZ - World Z coordinate in meters
   * @returns true if position is on a pathway
   */
  isOnPathway(worldX: number, worldZ: number): boolean {
    if (!this.config.pathwayConfig.enabled) {
      return false;
    }
    
    const path = this.config.pathwayConfig;
    const halfWidth = path.pathWidth * 0.5;
    
    // Apply domain warping for organic curved cells
    const [warpedX, warpedZ] = this.applyPathwayWarp(worldX, worldZ);
    
    // Get cell value at center
    const centerCell = this.pathwayCellular.GetNoise(warpedX, warpedZ);
    
    // Sample at offsets to detect if we're near a cell edge
    // Check 4 cardinal directions at pathWidth distance
    const [wx1, wz1] = this.applyPathwayWarp(worldX + halfWidth, worldZ);
    const [wx2, wz2] = this.applyPathwayWarp(worldX - halfWidth, worldZ);
    const [wx3, wz3] = this.applyPathwayWarp(worldX, worldZ + halfWidth);
    const [wx4, wz4] = this.applyPathwayWarp(worldX, worldZ - halfWidth);
    
    const cell1 = this.pathwayCellular.GetNoise(wx1, wz1);
    const cell2 = this.pathwayCellular.GetNoise(wx2, wz2);
    const cell3 = this.pathwayCellular.GetNoise(wx3, wz3);
    const cell4 = this.pathwayCellular.GetNoise(wx4, wz4);
    
    // If any neighbor has a different cell value, we're on an edge (pathway)
    // Use small epsilon for float comparison
    const eps = 0.001;
    return Math.abs(centerCell - cell1) > eps ||
           Math.abs(centerCell - cell2) > eps ||
           Math.abs(centerCell - cell3) > eps ||
           Math.abs(centerCell - cell4) > eps;
  }

  /**
   * Get how far "into" the path a position is (0 = edge, 1 = center)
   * Used for gradual dipping effect
   * @param worldX - World X coordinate in meters
   * @param worldZ - World Z coordinate in meters
   * @returns 0-1 depth factor, or 0 if not on path
   */
  getPathwayDepthFactor(worldX: number, worldZ: number): number {
    if (!this.config.pathwayConfig.enabled) {
      return 0;
    }
    
    const path = this.config.pathwayConfig;
    const halfWidth = path.pathWidth * 0.5;
    
    // Apply domain warping
    const [warpedX, warpedZ] = this.applyPathwayWarp(worldX, worldZ);
    const centerCell = this.pathwayCellular.GetNoise(warpedX, warpedZ);
    
    // Binary search to find distance to nearest cell edge
    // Start from center position and check at increasing distances
    const eps = 0.001;
    let minEdgeDist = halfWidth; // Start assuming we're at center
    
    // Check multiple sample points to find closest edge
    const sampleCount = 8;
    for (let i = 0; i < sampleCount; i++) {
      const angle = (i / sampleCount) * Math.PI * 2;
      const dx = Math.cos(angle);
      const dz = Math.sin(angle);
      
      // Sample at increasing distances to find where cell changes
      for (let dist = 0.1; dist <= halfWidth; dist += 0.2) {
        const [wx, wz] = this.applyPathwayWarp(worldX + dx * dist, worldZ + dz * dist);
        const cell = this.pathwayCellular.GetNoise(wx, wz);
        
        if (Math.abs(centerCell - cell) > eps) {
          // Found edge at this distance
          minEdgeDist = Math.min(minEdgeDist, dist);
          break;
        }
      }
    }
    
    // Convert distance to cell boundary into depth factor
    // minEdgeDist is SMALL at center (near cell boundary), LARGE at path edge
    // We want depth factor to be 1 at center, 0 at edge, so invert
    const t = 1 - Math.min(1, minEdgeDist / halfWidth);
    // Smoothstep for nice easing
    return smoothstep(0, 1, t);
  }

  /**
   * Check if a world position is on the outer wall edge of a pathway
   * Returns true if this position is just outside the path on one side
   * (the side where centerCell > neighborCell for consistent single-sided walls)
   * @param worldX - World X coordinate in meters
   * @param worldZ - World Z coordinate in meters
   * @returns true if position should have a wall
   */
  isOnPathwayWall(worldX: number, worldZ: number): boolean {
    if (!this.config.pathwayConfig.enabled || this.config.pathwayConfig.wallHeight <= 0) {
      return false;
    }
    
    const path = this.config.pathwayConfig;
    const halfWidth = path.pathWidth * 0.5;
    const wallOffset = halfWidth + 0.5; // Just outside the path
    
    // Apply domain warping for organic curved cells
    const [warpedX, warpedZ] = this.applyPathwayWarp(worldX, worldZ);
    
    // Get cell value at center
    const centerCell = this.pathwayCellular.GetNoise(warpedX, warpedZ);
    
    // Sample at offsets to detect if we're near a cell edge
    const [wx1, wz1] = this.applyPathwayWarp(worldX + wallOffset, worldZ);
    const [wx2, wz2] = this.applyPathwayWarp(worldX - wallOffset, worldZ);
    const [wx3, wz3] = this.applyPathwayWarp(worldX, worldZ + wallOffset);
    const [wx4, wz4] = this.applyPathwayWarp(worldX, worldZ - wallOffset);
    
    const cell1 = this.pathwayCellular.GetNoise(wx1, wz1);
    const cell2 = this.pathwayCellular.GetNoise(wx2, wz2);
    const cell3 = this.pathwayCellular.GetNoise(wx3, wz3);
    const cell4 = this.pathwayCellular.GetNoise(wx4, wz4);
    
    const eps = 0.001;
    
    // Only place wall on one side - where we're outside the path but adjacent to it
    // Check if we're NOT on the path but a neighbor IS on the path
    // Use consistent rule: wall on the "greater cell value" side
    const onPath = this.isOnPathway(worldX, worldZ);
    if (onPath) {
      return false; // Don't place wall on the path itself
    }
    
    // Check if any adjacent position is on the path AND we're on the "greater" side
    const isEdge1 = Math.abs(centerCell - cell1) > eps && centerCell > cell1;
    const isEdge2 = Math.abs(centerCell - cell2) > eps && centerCell > cell2;
    const isEdge3 = Math.abs(centerCell - cell3) > eps && centerCell > cell3;
    const isEdge4 = Math.abs(centerCell - cell4) > eps && centerCell > cell4;
    
    if (!(isEdge1 || isEdge2 || isEdge3 || isEdge4)) {
      return false;
    }
    
    // Check if the adjacent path position uses cobble material
    // Sample the path material at the nearest path position
    const checkPositions = [
      isEdge1 ? [worldX + wallOffset, worldZ] : null,
      isEdge2 ? [worldX - wallOffset, worldZ] : null,
      isEdge3 ? [worldX, worldZ + wallOffset] : null,
      isEdge4 ? [worldX, worldZ - wallOffset] : null,
    ].filter(Boolean) as [number, number][];
    
    for (const [px, pz] of checkPositions) {
      if (this.isOnPathway(px, pz)) {
        const pathMaterial = this.getPathwayMaterial(px, pz);
        if (this.config.pathwayConfig.wallMaterials.includes(pathMaterial)) {
          return true;
        }
      }
    }
    
    return false;
  }

  /**
   * Check if a world position is on the border of a pathway (just outside, no wall)
   * Used for the dirt border around paths
   * @param worldX - World X coordinate in meters
   * @param worldZ - World Z coordinate in meters
   * @returns true if position should have border material
   */
  isOnPathwayBorder(worldX: number, worldZ: number): boolean {
    if (!this.config.pathwayConfig.enabled || this.config.pathwayConfig.borderWidth <= 0) {
      return false;
    }
    
    // If we're on the path itself, not a border
    if (this.isOnPathway(worldX, worldZ)) {
      return false;
    }
    
    // If we're on a wall, not a border
    if (this.isOnPathwayWall(worldX, worldZ)) {
      return false;
    }
    
    const path = this.config.pathwayConfig;
    const halfWidth = path.pathWidth * 0.5;
    const borderDist = halfWidth + path.borderWidth;
    
    // Apply domain warping for organic curved cells
    const [warpedX, warpedZ] = this.applyPathwayWarp(worldX, worldZ);
    
    // Get cell value at center
    const centerCell = this.pathwayCellular.GetNoise(warpedX, warpedZ);
    
    // Sample at border distance to detect if we're near a cell edge
    const [wx1, wz1] = this.applyPathwayWarp(worldX + borderDist, worldZ);
    const [wx2, wz2] = this.applyPathwayWarp(worldX - borderDist, worldZ);
    const [wx3, wz3] = this.applyPathwayWarp(worldX, worldZ + borderDist);
    const [wx4, wz4] = this.applyPathwayWarp(worldX, worldZ - borderDist);
    
    const cell1 = this.pathwayCellular.GetNoise(wx1, wz1);
    const cell2 = this.pathwayCellular.GetNoise(wx2, wz2);
    const cell3 = this.pathwayCellular.GetNoise(wx3, wz3);
    const cell4 = this.pathwayCellular.GetNoise(wx4, wz4);
    
    const eps = 0.001;
    
    // Check if we're near a cell edge (within border distance)
    // Only on the side without walls (where centerCell < neighborCell)
    const isEdge1 = Math.abs(centerCell - cell1) > eps && centerCell < cell1;
    const isEdge2 = Math.abs(centerCell - cell2) > eps && centerCell < cell2;
    const isEdge3 = Math.abs(centerCell - cell3) > eps && centerCell < cell3;
    const isEdge4 = Math.abs(centerCell - cell4) > eps && centerCell < cell4;
    
    return isEdge1 || isEdge2 || isEdge3 || isEdge4;
  }

  /**
   * Get the current configuration
   */
  getConfig(): TerrainConfig {
    return { ...this.config };
  }

  /**
   * Apply domain warping to coordinates
   * @returns Warped [x, z] coordinates
   */
  private applyDomainWarp(worldX: number, worldZ: number): [number, number] {
    if (!this.config.domainWarp.enabled) {
      return [worldX, worldZ];
    }
    
    const amp = this.config.domainWarp.amplitude;
    const warpX = this.warpNoiseX.GetNoise(worldX, worldZ) * amp;
    const warpZ = this.warpNoiseZ.GetNoise(worldX, worldZ) * amp;
    
    return [worldX + warpX, worldZ + warpZ];
  }

  /**
   * Sample terrain height at a world position
   * @param worldX - World X coordinate in meters
   * @param worldZ - World Z coordinate in meters
   * @returns Height in voxels
   */
  sampleHeight(worldX: number, worldZ: number): number {
    // Apply domain warping for organic shapes
    const [warpedX, warpedZ] = this.applyDomainWarp(worldX, worldZ);
    
    let height = this.config.baseHeight;

    for (const layer of this.config.heightLayers) {
      height += this.sampleNoiseLayer(warpedX, warpedZ, layer);
    }

    return height;
  }

  /**
   * Sample terrain surface at a world position (height + material)
   * Used for map tile generation without creating full chunks.
   * @param worldX - World X coordinate in meters
   * @param worldZ - World Z coordinate in meters
   * @returns Surface height (voxels) and material ID
   */
  sampleSurface(worldX: number, worldZ: number): { height: number; material: number } {
    const originalHeight = this.sampleHeight(worldX, worldZ);
    let height = originalHeight;
    
    // Apply pathway dip
    const isPath = this.isOnPathway(worldX, worldZ);
    let pathDipAmount = 0;
    if (isPath && this.config.pathwayConfig.dipDepth > 0) {
      const depthFactor = this.getPathwayDepthFactor(worldX, worldZ);
      pathDipAmount = this.config.pathwayConfig.dipDepth * depthFactor;
      height -= pathDipAmount;
    }
    
    // Determine surface material
    let material: number;
    
    // Check for water on path first
    const waterConfig = this.config.pathwayConfig;
    if (waterConfig.waterEnabled && isPath && pathDipAmount > 0) {
      // Water fills the dip, so the visible surface is water
      material = waterConfig.waterMaterial;
      // Return the water surface height (original height minus water depth)
      height = originalHeight - waterConfig.waterDepth;
    } else if (isPath) {
      material = this.getPathwayMaterial(worldX, worldZ);
    } else if (this.isOnPathwayBorder(worldX, worldZ)) {
      material = this.config.pathwayConfig.borderMaterial;
    } else {
      // Surface material (depth 0)
      material = this.getMaterialAtDepth(0);
    }
    
    return { height: Math.floor(height), material };
  }

  /**
   * Get material ID based on depth from surface
   * @param depthFromSurface - Depth in voxels (positive = inside terrain)
   * @returns Material ID
   */
  private getMaterialAtDepth(depthFromSurface: number): number {
    for (const layer of this.config.materialLayers) {
      if (depthFromSurface <= layer.maxDepth) {
        return layer.materialId;
      }
    }
    return this.config.defaultMaterial;
  }

  /**
   * Sample a single noise layer with octave support (FBM - Fractal Brownian Motion)
   * Returns height contribution in voxels
   */
  private sampleNoiseLayer(worldX: number, worldZ: number, layer: NoiseLayerConfig): number {
    let value = 0;
    let frequency = layer.frequency;
    let amplitude = layer.amplitude;

    // Accumulate octaves - each octave adds finer detail at reduced amplitude
    for (let o = 0; o < layer.octaves; o++) {
      value += this.heightNoise.GetNoise(worldX * frequency, worldZ * frequency) * amplitude;
      frequency *= layer.lacunarity;
      amplitude *= layer.persistence;
    }

    return value;
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
        let terrainHeight = this.sampleHeight(worldX, worldZ);
        
        // Cache pathway checks for this column (only depends on X/Z)
        const isPathColumn = this.isOnPathway(worldX, worldZ);
        let isWallColumn = -1; // -1 = not checked, 0 = no, 1 = yes
        let isBorderColumn = -1;
        
        // Store original terrain height before dip (for water level calculation)
        const originalTerrainHeight = terrainHeight;
        
        // Apply gradual dip to terrain height on pathways (deeper in center)
        let pathDipAmount = 0;
        if (isPathColumn && this.config.pathwayConfig.dipDepth > 0) {
          const depthFactor = this.getPathwayDepthFactor(worldX, worldZ);
          pathDipAmount = this.config.pathwayConfig.dipDepth * depthFactor;
          terrainHeight -= pathDipAmount;
        }
        
        // Calculate water level for this column (if water is enabled)
        // Water surface is at original terrain height minus waterDepth
        const waterConfig = this.config.pathwayConfig;
        const waterLevel = waterConfig.waterEnabled && isPathColumn && pathDipAmount > 0
          ? originalTerrainHeight - waterConfig.waterDepth
          : -Infinity;

        for (let ly = 0; ly < CHUNK_SIZE; ly++) {
          // Calculate voxel's Y position in world voxel space
          const voxelY = chunkWorldY + ly;
          
          // Calculate signed distance from surface
          // Positive = inside terrain (solid), Negative = outside (air)
          const distanceFromSurface = terrainHeight - voxelY;
          
          // Convert to weight (+0.5 = solid, -0.5 = air, 0 = surface)
          // Clamp to [-0.5, 0.5] range
          const weight = Math.max(-0.5, Math.min(0.5, distanceFromSurface * 0.5));
          
          // Determine material based on depth from surface
          let material = 0;
          let finalWeight = weight;
          
          if (weight > -0.5) {
            // Only assign material if not fully air
            const depthFromSurface = Math.max(0, distanceFromSurface);
            material = this.getMaterialAtDepth(depthFromSurface);
            
            // Check for pathway override on surface voxels (use cached check)
            if (depthFromSurface <= this.config.pathwayConfig.maxDepth && isPathColumn) {
              material = this.getPathwayMaterial(worldX, worldZ);
            }
            
            // Check for border material (dirt2 along path edges, not on wall side)
            if (depthFromSurface <= this.config.pathwayConfig.maxDepth && !isPathColumn) {
              if (isBorderColumn === -1) {
                isBorderColumn = this.isOnPathwayBorder(worldX, worldZ) ? 1 : 0;
              }
              if (isBorderColumn === 1) {
                material = this.config.pathwayConfig.borderMaterial;
              }
            }
          }
          
          // Check for pathway wall (short brick wall on one side of cobble paths)
          // Only check if we're within wall height range of surface (cheap check first)
          const wallHeight = this.config.pathwayConfig.wallHeight;
          const heightAboveSurface = voxelY - terrainHeight;
          if (wallHeight > 0 && 
              heightAboveSurface >= 0 && 
              heightAboveSurface < wallHeight) {
            // Lazy evaluate wall check - only compute once per column
            if (isWallColumn === -1) {
              isWallColumn = this.isOnPathwayWall(worldX, worldZ) ? 1 : 0;
            }
            if (isWallColumn === 1) {
              // Make this voxel solid with wall material
              finalWeight = 0.5;
              material = this.config.pathwayConfig.wallMaterial;
            }
          }
          
          // Fill pathway dips with water
          // Water fills the space between dipped terrain and water level
          if (waterLevel > -Infinity && finalWeight < 0.5) {
            // Only fill voxels that are:
            // 1. Above the dipped terrain (not already solid ground)
            // 2. Below or at the water level
            if (voxelY <= waterLevel && voxelY > terrainHeight) {
              // Calculate water weight based on distance from water surface
              const distanceFromWaterSurface = waterLevel - voxelY;
              const waterWeight = Math.max(-0.5, Math.min(0.5, distanceFromWaterSurface * 0.5));
              finalWeight = waterWeight;
              material = waterConfig.waterMaterial;
            }
          }
          
          // Default light level
          const light = 0;
          
          // Pack and store voxel
          const index = lx + ly * CHUNK_SIZE + lz * CHUNK_SIZE * CHUNK_SIZE;
          data[index] = packVoxel(finalWeight, material, light);
        }
      }
    }

    // Apply stamps (trees, rocks) if enabled
    if (this.stampPointGenerator && this.stampPlacer) {
      const allPlacements = this.stampPointGenerator.generateForChunk(cx, cz);
      // Filter out placements that are on pathways
      const placements = allPlacements.filter(p => !this.isOnPathway(p.worldX, p.worldZ));
      this.stampPlacer.applyStamps(data, cx, cy, cz, placements, this);
    }

    return data;
  }
}
