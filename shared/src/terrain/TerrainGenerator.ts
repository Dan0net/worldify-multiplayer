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
  StampType,
  DEFAULT_STAMP_DISTRIBUTION,
  hashInt2,
  makeRng,
  type StampDistributionConfig,
  type StampPlacement,
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

export interface CaveConfig {
  /**
   * Cave types are independently toggleable and combine — enable either, both, or neither.
   * - wormsEnabled   — traced "Perlin worms": individually-wandering tube tunnels.
   * - cavernsEnabled — large, tall chambers (3D-noise-warped ellipsoids) with stalagmites /
   *                    stalactites and water pools at the bottom.
   * Both false = no caves (terrain untouched).
   */
  wormsEnabled: boolean;
  cavernsEnabled: boolean;
  /** Optional hard floor in meters; no caves are carved below this world Y. */
  floorY?: number;

  // --- Worms: traced, individually-wandering tube tunnels ---
  /** Spawn-grid cell size in meters; one hashed batch of worms per cell (larger = sparser starts). */
  wormCellSize: number;
  /** Expected worms per cell (fractional — e.g. 0.6 spawns one worm ~60% of cells). */
  wormsPerCell: number;
  /** Number of trace steps per worm (length ≈ wormSegments × wormStep meters). */
  wormSegments: number;
  /** Distance advanced per trace step in meters (also the sphere spacing along the tube). */
  wormStep: number;
  /** Base tube radius in meters (tunnel half-width). */
  wormRadius: number;
  /** Per-worm radius variation, 0..1 (0 = uniform, 0.3 = ±30%). */
  wormRadiusJitter: number;
  /** Flow-field frequency (1/m); higher = tighter, more frequent left/right winding. */
  wormSteerFrequency: number;
  /** How hard a worm turns toward the local flow heading each step, 0..1 (higher = follows tightly). */
  wormTurnRate: number;
  /** Max vertical wander in radians (small → worms stay near their start depth, curve left/right). */
  wormPitchRange: number;
  /** Hard clamp on pitch magnitude in radians so no worm ever plunges/climbs too steeply. */
  wormMaxPitch: number;
  /** Gentle constant downward drift in radians (0 = level on average → even Y distribution). */
  wormDownwardDrift: number;
  /** Radius variation ALONG each worm, 0..1 — low-freq bulges (chambers) and pinches (squeezes). */
  wormRadiusAlongVar: number;
  /** Wall-roughness displacement amplitude in meters (0 = perfectly smooth tube walls). */
  wormWallAmp: number;
  /** Wall-roughness noise frequency (1/m); higher = finer bumps. */
  wormWallFrequency: number;
  /** 0..1 — how much worms share a steering flow-field. Higher = converge/fork more (braided). */
  wormConvergence: number;

  // --- Caverns: large tall chambers on a spacing grid (warped ellipsoids) ---
  /** Spawn-grid cell size in meters; caverns seed one hashed batch per 3D cell (larger = sparser). */
  cavernCellSize: number;
  /** Expected caverns per cell (fractional — e.g. 1.0 spawns ~one cavern per cell). */
  cavernsPerCell: number;
  /** Base horizontal radius in meters (cavern size / width). */
  cavernRadius: number;
  /** Per-cavern radius variation, 0..1 (0 = uniform, 0.3 = ±30% between caverns). */
  cavernRadiusJitter: number;
  /** Vertical elongation: vertical radius = horizontal radius × (1 + this). Higher = taller chambers. */
  cavernVerticality: number;
  /** Domain-warp amplitude in meters applied to the cavern boundary (0 = clean ellipsoid walls). */
  cavernWinding: number;
  /** Wall-roughness displacement amplitude in meters (0 = smooth walls; adds fine bumps). */
  cavernWallAmp: number;
  /** Wall-roughness / shape noise frequency (1/m); higher = finer bumps. */
  cavernWallFrequency: number;
  /** Domain-warp noise frequency (1/m) paired with cavernWinding (lower = broader lobes). */
  cavernWarpFrequency: number;
  /** Fraction of a cavern's height (0..1) filled with water from the bottom (0 = dry). */
  cavernWaterLevel: number;
  /** 0..1 — stalagmite/stalactite abundance + size (0 = none; higher = denser, taller spikes). */
  cavernSpikeAmount: number;
  /** 0..1 — how much cavern tops narrow where they breach the surface (0 = full-size breaches; higher
   *  = smaller openings, but never fully sealed). */
  cavernTerrainTaper: number;
}

/**
 * Per-world "Terrain" generation layer — the base landscape (heightmap land, pathway roads with
 * their walls + water, and stamps: trees / rocks / buildings). Toggleable and tunable alongside the
 * worms/caverns cave layers. When disabled, the base terrain is skipped entirely (and any enabled
 * cave layer is rendered as solid casts for inspection).
 */
export interface TerrainLayerConfig {
  /** Master toggle for the base landscape + pathways + stamps. */
  enabled: boolean;
  /** Pathway network spacing in meters (distance between path cells; larger = sparser roads). */
  pathSpacing: number;
  /** Pathway width in meters. */
  pathWidth: number;
  /** Pathway domain-warp amplitude in meters (how far roads meander from straight). */
  pathWarpAmplitude: number;
  /** Pathway domain-warp frequency (1/m); higher = tighter wiggles. */
  pathWarpFrequency: number;
  /** Building spacing in meters (grid spacing for the largest building type; larger = fewer). */
  buildingSpacing: number;
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
  /** Cave-tunnel generation configuration */
  caveConfig: CaveConfig;
  /** Base-terrain generation layer (land + pathways + stamps) toggle + tunables */
  terrainLayer: TerrainLayerConfig;
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

/** Worms only seed at or below this world Y (meters) — a few metres above the max terrain height —
 *  so worms carve down "from above the top of the terrain" without wasting traces on high-air cells. */
const WORM_SEED_TOP_Y = 8;

/** Max meters of per-worm steering-noise offset at wormConvergence=0 (fully independent worms).
 *  Kept small so that even at the higher steering frequency the shared flow-field (→ convergence)
 *  survives — offset-in-noise-periods = phase × steerFrequency stays modest. */
const WORM_PHASE_SCALE = 280;
/** Frequency (1/m) of the along-worm radius-variation noise (low → long bulges/pinches). */
const WORM_RADIUS_VAR_FREQ = 0.04;
/** Hard floor on a worm's stored tube radius (meters) — caps how much along-worm variation can
 *  pinch a tube. Must stay ≥ WORM_CARVE_MIN so the carve floor never widens a worm's reach beyond
 *  the gather bound (which would open a seam). */
const WORM_MIN_RADIUS = 1.0;
/** Floor on the EFFECTIVE carve radius (after taper + wall roughness), so consecutive spheres always
 *  overlap (must exceed wormStep/2) → tunnels never break into disconnected blobs. Kept ≤
 *  WORM_MIN_RADIUS so it never reaches past the per-sphere gather cull. */
const WORM_CARVE_MIN = 0.9;

/** Caverns only seed at or below this world Y (meters) — like WORM_SEED_TOP_Y — so chambers form
 *  under the terrain, not floating in the sky. */
const CAVERN_SEED_TOP_Y = 8;
/** Stalagmite/stalactite hash-grid spacing in meters (one candidate spike per XZ cell). */
const CAVERN_SPIKE_CELL = 3;
/** Max stalagmite/stalactite height in meters at cavernSpikeAmount = 1. */
const CAVERN_SPIKE_MAX_H = 7;
/** Max spike base radius in meters at cavernSpikeAmount = 1. */
const CAVERN_SPIKE_MAX_R = 1.3;
/** Meters below the surface over which a surface-tapered cavern widens back to full radius. */
const CAVERN_TAPER_BAND = 24;
/** Tightest surface opening as a fraction of full radius at cavernTerrainTaper = 1 (still breaches). */
const CAVERN_TAPER_MIN_FRAC = 0.15;

// ============== Default Cave Configuration ==============

export const DEFAULT_CAVE_CONFIG: CaveConfig = {
  wormsEnabled: true,       // traced worms on by default (the established look)
  cavernsEnabled: false,    // caverns off until dialled in; combine with worms once refined
  floorY: undefined,        // no hard floor by default

  // Worms (traced tunnels). Seeded on a 3D grid so they fill the whole depth from just above the
  // surface downward.
  wormCellSize: 40,         // 40 m spawn cells (3D grid)
  wormsPerCell: 2.0,        // worms per 3D cell
  wormSegments: 150,        // long worms (150 × 1.2 m ≈ 180 m)
  wormStep: 1.2,            // 1.2 m per step (dense spheres → smooth, connected tunnels)
  wormRadius: 2.0,          // ~4 m diameter tunnels
  wormRadiusJitter: 0.3,    // ±30% width variety between tunnels
  wormSteerFrequency: 0.05, // low flow-field frequency → large, sweeping bends
  wormTurnRate: 1.0,        // follow the flow heading tightly (max winding)
  wormPitchRange: 2.5,      // strong vertical wander (clamped by wormMaxPitch)
  wormMaxPitch: 1.0,        // clamp on steepness
  wormDownwardDrift: 0.0,   // level on average
  wormRadiusAlongVar: 0.5,  // ±50% radius wobble along each worm → chambers + squeezes
  wormWallAmp: 0.6,         // 0.6 m wall roughness → irregular walls
  wormWallFrequency: 0.4,   // fine wall bumps
  wormConvergence: 0.45,    // worms share much of the flow-field → natural merges/forks

  // Caverns (large tall chambers). Clean tall ellipsoids by default: winding / wall roughness /
  // size variety all start at 0 so you can dial each one up from a smooth baseline.
  cavernCellSize: 90,       // 90 m spawn cells → caverns spaced far apart
  cavernsPerCell: 1.0,      // ~one cavern per cell
  cavernRadius: 14,         // 14 m base horizontal radius
  cavernRadiusJitter: 0.0,  // uniform size to start
  cavernVerticality: 1.4,   // vertical radius ≈ 2.4× horizontal → tall chambers
  cavernWinding: 0.0,       // clean ellipsoid walls to start
  cavernWallAmp: 0.0,       // smooth walls to start
  cavernWallFrequency: 0.25,// wall-bump scale (used once wall roughness > 0)
  cavernWarpFrequency: 0.03,// domain-warp scale (used once winding > 0)
  cavernWaterLevel: 0.15,   // bottom ~15% of each chamber filled with water
  cavernSpikeAmount: 0.3,   // moderate stalagmites/stalactites
  cavernTerrainTaper: 0.6,  // narrow surface breaches to ~half size (still open)
};

// ============== Default Terrain Layer Configuration ==============

export const DEFAULT_TERRAIN_LAYER_CONFIG: TerrainLayerConfig = {
  enabled: true,            // base landscape + pathways + stamps on by default
  pathSpacing: 125,         // ~125 m between path cells (matches pathway frequency 0.008)
  pathWidth: 3.0,           // 3 m roads
  pathWarpAmplitude: 90,    // strong meander
  pathWarpFrequency: 0.011, // smooth curves
  buildingSpacing: 50,      // largest building grid (matches the stamp default)
};

/**
 * Back-compat: translate a legacy single-`mode` cave config into the wormsEnabled/cavernsEnabled
 * model. Older worlds (persisted per-world in IndexedDB) and the new-world localStorage stored
 * `mode: 'off'|'spaghetti'|'cellular'|'worms'|'worley'`. Removed types and 'off' map to both-off;
 * 'worms'/'caverns' map to the matching toggle. Configs already in the new shape pass through. Also
 * strips fields from the removed types so they don't linger on the object.
 */
export function normalizeCaveConfig(
  input: (Partial<CaveConfig> & { mode?: string }) | null | undefined,
): Partial<CaveConfig> {
  if (!input) return {};
  const { mode, ...rest } = input as Partial<CaveConfig> & { mode?: string; [k: string]: unknown };
  const out = rest as Partial<CaveConfig> & { [k: string]: unknown };
  if (typeof mode === 'string' && out.wormsEnabled === undefined && out.cavernsEnabled === undefined) {
    out.wormsEnabled = mode === 'worms';
    out.cavernsEnabled = mode === 'caverns';
  }
  // Drop keys from the removed spaghetti/cellular/worley types if present on a legacy object.
  for (const k of [
    'verticalSquash', 'frequency', 'radius', 'regionFrequency', 'regionThreshold',
    'cellFrequency', 'edgeThreshold', 'cellDistanceFunction', 'warpFrequency', 'warpAmplitude',
    'worleyFrequency', 'worleyCutoff', 'worleyWarpFrequency', 'worleyWarpAmplitude',
    'worleyXZCompression', 'worleyYCompression',
  ]) delete out[k];
  return out;
}

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
  caveConfig: DEFAULT_CAVE_CONFIG,
  terrainLayer: DEFAULT_TERRAIN_LAYER_CONFIG,
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

  // Cave system - 3D noise fields (seed block config.seed + 30000)
  private caveWormSteerYaw: FastNoiseLite;   // worms: heading steering (yaw)
  private caveWormSteerPitch: FastNoiseLite; // worms: heading steering (pitch)
  private caveWormRadius: FastNoiseLite;     // worms: low-freq along-worm radius variation
  private caveWormWall: FastNoiseLite;       // worms: per-voxel wall roughness
  private caveCavernWarpX: FastNoiseLite;    // caverns: per-axis domain warp (winding)
  private caveCavernWarpY: FastNoiseLite;
  private caveCavernWarpZ: FastNoiseLite;
  private caveCavernWall: FastNoiseLite;     // caverns: per-voxel wall roughness

  // Worm state: traced worms cached per spawn cell, and the sphere centers (flat
  // [x,y,z,r,...] in world meters) relevant to the chunk currently being generated.
  private wormCellCache = new Map<string, Float64Array>();
  private chunkWormPts: Float64Array = new Float64Array(0);
  private chunkWormPtsFor = '';

  // Cavern state: caverns cached per spawn cell, and the descriptors ([cx,cy,cz,rx,…] in world
  // meters) relevant to the chunk currently being generated.
  private cavernCellCache = new Map<string, Float64Array>();
  private chunkCavernFeats: Float64Array = new Float64Array(0);
  private chunkCavernFeatsFor = '';

  /** Test-only: extra worm-gather cells added on every side. Proves the gather radius is sufficient
   *  (regenerating with a larger radius must be byte-identical). Leave 0 in production. */
  wormGatherExtraCells = 0;
  /** Test-only: same idea for caverns. */
  cavernGatherExtraCells = 0;

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
    if (config.caveConfig) {
      this.config.caveConfig = { ...DEFAULT_CAVE_CONFIG, ...normalizeCaveConfig(config.caveConfig) };
    }
    if (config.terrainLayer) {
      this.config.terrainLayer = { ...DEFAULT_TERRAIN_LAYER_CONFIG, ...config.terrainLayer };
    }
    // Fold the friendly Terrain-layer tunables onto pathwayConfig + stampConfig (single source of
    // truth). No-op at defaults, so a default generator stays byte-identical to before.
    this.applyTerrainLayer();

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

    // Cave noise — fixed seed block (config.seed + 30000+) so the seed++ chain above is untouched.
    // All generators are built up-front (cheap); only the enabled types are sampled per voxel.
    let caveSeed = this.config.seed + 30000;
    // Worms: two 3D FBM fields steer each worm's heading (yaw + pitch) as it's traced.
    this.caveWormSteerYaw = new FastNoiseLite(caveSeed++);
    this.caveWormSteerYaw.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    this.caveWormSteerYaw.SetFractalType(FastNoiseLite.FractalType.FBm);
    this.caveWormSteerYaw.SetFractalOctaves(2);
    this.caveWormSteerPitch = new FastNoiseLite(caveSeed++);
    this.caveWormSteerPitch.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    this.caveWormSteerPitch.SetFractalType(FastNoiseLite.FractalType.FBm);
    this.caveWormSteerPitch.SetFractalOctaves(2);
    // Worms: along-worm radius variation (low freq) + per-voxel wall roughness (higher freq).
    this.caveWormRadius = new FastNoiseLite(caveSeed++);
    this.caveWormRadius.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    this.caveWormRadius.SetFrequency(WORM_RADIUS_VAR_FREQ);
    this.caveWormWall = new FastNoiseLite(caveSeed++);
    this.caveWormWall.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    this.caveWormWall.SetFractalType(FastNoiseLite.FractalType.FBm);
    this.caveWormWall.SetFractalOctaves(2);
    // Caverns: per-axis Perlin domain warp (winding) + Perlin wall roughness.
    this.caveCavernWarpX = new FastNoiseLite(caveSeed++);
    this.caveCavernWarpX.SetNoiseType(FastNoiseLite.NoiseType.Perlin);
    this.caveCavernWarpY = new FastNoiseLite(caveSeed++);
    this.caveCavernWarpY.SetNoiseType(FastNoiseLite.NoiseType.Perlin);
    this.caveCavernWarpZ = new FastNoiseLite(caveSeed++);
    this.caveCavernWarpZ.SetNoiseType(FastNoiseLite.NoiseType.Perlin);
    this.caveCavernWall = new FastNoiseLite(caveSeed++);
    this.caveCavernWall.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    this.caveCavernWall.SetFractalType(FastNoiseLite.FractalType.FBm);
    this.caveCavernWall.SetFractalOctaves(2);

    this.updateCaveConfig();

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
    if (config.caveConfig) {
      this.config.caveConfig = { ...this.config.caveConfig, ...normalizeCaveConfig(config.caveConfig) };
      this.updateCaveConfig();
      this.invalidateCaveCaches();   // config change invalidates traced worms/caverns
    }

    if (config.seed !== undefined) {
      let seed = config.seed;
      this.heightNoise.SetSeed(seed++);
      this.warpNoiseX.SetSeed(seed++);
      this.warpNoiseZ.SetSeed(seed++);

      let caveSeed = config.seed + 30000;
      this.caveWormSteerYaw.SetSeed(caveSeed++);
      this.caveWormSteerPitch.SetSeed(caveSeed++);
      this.caveWormRadius.SetSeed(caveSeed++);
      this.caveWormWall.SetSeed(caveSeed++);
      this.caveCavernWarpX.SetSeed(caveSeed++);
      this.caveCavernWarpY.SetSeed(caveSeed++);
      this.caveCavernWarpZ.SetSeed(caveSeed++);
      this.caveCavernWall.SetSeed(caveSeed++);
      this.invalidateCaveCaches();   // reseed invalidates traced worms/caverns
    }
  }

  /** Drop all per-cell + per-chunk cave caches (after a config or seed change). */
  private invalidateCaveCaches(): void {
    this.wormCellCache.clear();
    this.chunkWormPtsFor = '';
    this.cavernCellCache.clear();
    this.chunkCavernFeatsFor = '';
  }

  /**
   * Fold the friendly Terrain-layer tunables onto the underlying pathway + stamp configs, which is
   * where the generator actually reads them. At the defaults this reproduces the built-in pathway /
   * building settings exactly (so a default world is unchanged). Called before the pathway/stamp
   * systems are (re)built.
   */
  private applyTerrainLayer(): void {
    const t = this.config.terrainLayer;
    this.config.pathwayConfig = {
      ...this.config.pathwayConfig,
      frequency: 1 / Math.max(1, t.pathSpacing),  // cell size in meters ≈ 1/frequency
      pathWidth: t.pathWidth,
      warpAmplitude: t.pathWarpAmplitude,
      warpFrequency: t.pathWarpFrequency,
    };
    // Scale only the building distributions by buildingSpacing; leave rocks/trees as-is. Keeps the
    // default (50 m) byte-identical to DEFAULT_STAMP_DISTRIBUTION.
    const distributions = DEFAULT_STAMP_DISTRIBUTION.distributions.map((d) => {
      if (d.type === StampType.BUILDING_SMALL)
        return { ...d, gridSize: t.buildingSpacing, exclusionRadius: t.buildingSpacing * 0.4 };
      if (d.type === StampType.BUILDING_HUT)
        return { ...d, gridSize: t.buildingSpacing * 0.6, exclusionRadius: t.buildingSpacing * 0.3 };
      return d;
    });
    this.config.stampConfig = { ...this.config.stampConfig, distributions };
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
   * Update cave noise configuration (frequencies).
   */
  private updateCaveConfig(): void {
    const cave = this.config.caveConfig;
    this.caveWormSteerYaw.SetFrequency(cave.wormSteerFrequency);
    this.caveWormSteerPitch.SetFrequency(cave.wormSteerFrequency);
    this.caveWormWall.SetFrequency(cave.wormWallFrequency);
    this.caveCavernWarpX.SetFrequency(cave.cavernWarpFrequency);
    this.caveCavernWarpY.SetFrequency(cave.cavernWarpFrequency);
    this.caveCavernWarpZ.SetFrequency(cave.cavernWarpFrequency);
    this.caveCavernWall.SetFrequency(cave.cavernWallFrequency);
  }

  /**
   * Pure predicate: is this world voxel inside a cave (to be carved to air)?
   *
   * Seamless by construction — it depends only on the world position, so any chunk sampling the
   * same voxel gets the same answer with no cross-chunk bookkeeping. The caller already gates on
   * depth/material; the depth checks here keep the function self-contained (and drive the taper).
   *
   * @param worldX - world X in meters
   * @param worldYmeters - world Y in METERS (caller passes voxelY * VOXEL_SCALE — Y is voxels in the loop)
   * @param worldZ - world Z in meters
   * @param distanceFromSurface - voxels below the surface (>0 = underground)
   */
  isInsideCave(worldX: number, worldYmeters: number, worldZ: number, surfaceMeters: number): boolean {
    return this.caveFillAt(worldX, worldYmeters, worldZ, surfaceMeters) !== 0;
  }

  /**
   * Combined per-voxel cave fill across every enabled type:
   *   0 = solid (leave terrain), 1 = air (carve), 2 = water.
   * Worms carve air only; caverns carve air, place water in the bottom, and leave stalagmite /
   * stalactite spikes solid. Air wins over water, so a worm bores cleanly through a cavern pool.
   * `surfaceMeters` is the terrain top at this column (meters) — used only by the cavern surface
   * taper. Pure function of world position (given the per-chunk prepared sets) → seamless.
   */
  caveFillAt(worldX: number, worldYmeters: number, worldZ: number, surfaceMeters: number): 0 | 1 | 2 {
    const cave = this.config.caveConfig;
    if (cave.floorY !== undefined && worldYmeters < cave.floorY) return 0;
    if (cave.wormsEnabled && this.isInsideWormCave(worldX, worldYmeters, worldZ)) return 1;
    if (cave.cavernsEnabled) {
      const c = this.sampleCavern(worldX, worldYmeters, worldZ, surfaceMeters);
      if (c !== 0) return c;
    }
    return 0;
  }

  /**
   * Mode B predicate — inside a traced worm tube? Tests the sphere centers prepared for the current
   * chunk (a flat [x,y,z,r,…] list built by prepareChunkWorms). Linear scan with a squared-distance
   * early-out; the list is small (only worms crossing this chunk) and empty for chunks with no worms.
   */
  private isInsideWormCave(x: number, y: number, z: number): boolean {
    const pts = this.chunkWormPts;
    if (pts.length === 0) return false;
    // Signed wall displacement at this voxel → bumpy, organic walls (added to every tube's radius).
    const cave = this.config.caveConfig;
    const wall = cave.wormWallAmp > 0 ? this.caveWormWall.GetNoise(x, y, z) * cave.wormWallAmp : 0;
    for (let i = 0; i < pts.length; i += 4) {
      const dx = x - pts[i];
      const dy = y - pts[i + 1];
      const dz = z - pts[i + 2];
      // Floor the effective radius so negative wall-roughness can't pinch a tube below the sphere
      // spacing and disconnect it. The floor ≤ WORM_MIN_RADIUS ≤ stored radius, so it never reaches
      // past the gather cull → still seamless.
      let reff = pts[i + 3] + wall;
      if (reff < WORM_CARVE_MIN) reff = WORM_CARVE_MIN;
      if (dx * dx + dy * dy + dz * dz < reff * reff) return true;
    }
    return false;
  }

  /**
   * Trace every worm spawned by one 3D spawn-cell (ci,cj,ck) and return their sphere centers as a
   * flat [x,y,z,r,…] Float64Array in world meters. Pure function of (ci,cj,ck,seed) — so every chunk
   * that gathers this cell reproduces identical worms (the seam guarantee). Cached per cell. Worms
   * are seeded on a 3D grid, so they fill the whole sub-surface volume from the top of the terrain
   * downward with no surface-margin / depth-range parameters.
   */
  private traceWormCell(ci: number, cj: number, ck: number): Float64Array {
    const cacheKey = ci + ',' + cj + ',' + ck;
    const cached = this.wormCellCache.get(cacheKey);
    if (cached) return cached;

    const cave = this.config.caveConfig;
    const cs = cave.wormCellSize;
    const seed = (this.config.seed + 40000) >>> 0;
    const rng = makeRng((hashInt2(hashInt2(ci, cj), ck) ^ seed) >>> 0);

    // Fractional density: floor + a probabilistic extra worm.
    let n = Math.floor(cave.wormsPerCell);
    if (rng() < cave.wormsPerCell - n) n++;

    // Per-worm steering offset; smaller with higher convergence → worms share a flow-field and braid.
    const phaseScale = WORM_PHASE_SCALE * (1 - cave.wormConvergence);

    const pts: number[] = [];
    for (let w = 0; w < n; w++) {
      // Start: jittered anywhere inside the 3D cell (no surface reference).
      const hx0 = (ci + rng()) * cs;
      const hy0 = (ck + rng()) * cs;
      const hz0 = (cj + rng()) * cs;
      let hx = hx0, hy = hy0, hz = hz0;

      let yaw = rng() * Math.PI * 2;   // seeded heading; immediately steered toward the flow field
      let pitch = 0;
      const baseR = cave.wormRadius * (1 + (rng() * 2 - 1) * cave.wormRadiusJitter);
      const phase = rng() * phaseScale;

      for (let s = 0; s <= cave.wormSegments; s++) {
        // Radius bulges/pinches along the worm (low-freq noise → chambers and squeezes), floored so
        // a pinch never becomes impassable.
        const radius = Math.max(
          WORM_MIN_RADIUS,
          baseR * (1 + cave.wormRadiusAlongVar * this.caveWormRadius.GetNoise(hx, hy, hz)),
        );
        pts.push(hx, hy, hz, radius);

        // Steer toward a SHARED flow field (pure function of position): worms passing through the
        // same region seek the same heading → they align, converge, and split where the field
        // diverges — coherent horizontal spiralling instead of a knotting random walk.
        const targetYaw = this.caveWormSteerYaw.GetNoise(hx + phase, hy, hz + phase) * Math.PI;
        let dYaw = targetYaw - yaw;
        dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));   // wrap to [-π, π]
        yaw += dYaw * cave.wormTurnRate;

        // Pitch stays gentle: a small vertical wander around a (near-zero) drift, hard-clamped so
        // worms never plunge — they curve left/right and hold their depth band.
        let targetPitch = this.caveWormSteerPitch.GetNoise(hx + phase, hy, hz + phase) * cave.wormPitchRange - cave.wormDownwardDrift;
        if (targetPitch > cave.wormMaxPitch) targetPitch = cave.wormMaxPitch;
        else if (targetPitch < -cave.wormMaxPitch) targetPitch = -cave.wormMaxPitch;
        pitch += (targetPitch - pitch) * cave.wormTurnRate;

        const cp = Math.cos(pitch);
        hx += Math.cos(yaw) * cp * cave.wormStep;
        hy += Math.sin(pitch) * cave.wormStep;
        hz += Math.sin(yaw) * cp * cave.wormStep;
      }
    }

    const arr = new Float64Array(pts);
    if (this.wormCellCache.size > 4096) this.wormCellCache.clear();  // simple bounded cache
    this.wormCellCache.set(cacheKey, arr);
    return arr;
  }

  /**
   * Build the worm sphere-set relevant to a chunk. Gathers every spawn-cell within a worm's maximum
   * reach (wormSegments × wormStep + radius) of the chunk — a hard bound, since each trace step
   * advances a fixed distance — so no worm that could carve into the chunk is missed. This is what
   * makes carving seamless: adjacent chunks gather overlapping cells and trace the same worms.
   */
  private prepareChunkWorms(cx: number, cy: number, cz: number): void {
    const key = cx + ',' + cy + ',' + cz;
    if (this.chunkWormPtsFor === key) return;

    const cave = this.config.caveConfig;
    const cs = cave.wormCellSize;
    const x0 = cx * CHUNK_SIZE * VOXEL_SCALE, x1 = x0 + CHUNK_SIZE * VOXEL_SCALE;
    const z0 = cz * CHUNK_SIZE * VOXEL_SCALE, z1 = z0 + CHUNK_SIZE * VOXEL_SCALE;
    const y0 = cy * CHUNK_SIZE * VOXEL_SCALE, y1 = y0 + CHUNK_SIZE * VOXEL_SCALE;

    // Outward slop beyond a sphere's stored radius: the wall-roughness noise can bulge the surface
    // out by up to wormWallAmp. This MUST inflate both the gather radius and the per-sphere cull, or
    // a chunk could drop a worm whose rough wall just reaches into it → a seam.
    const wallSlop = cave.wormWallAmp;
    const maxR = cave.wormRadius * (1 + cave.wormRadiusJitter) * (1 + cave.wormRadiusAlongVar) + wallSlop;
    const maxReach = cave.wormSegments * cave.wormStep + maxR;
    const gatherCells = Math.ceil(maxReach / cs) + 1 + this.wormGatherExtraCells;
    const ciMin = Math.floor(x0 / cs) - gatherCells, ciMax = Math.floor(x1 / cs) + gatherCells;
    const cjMin = Math.floor(z0 / cs) - gatherCells, cjMax = Math.floor(z1 / cs) + gatherCells;
    // Worms are seeded on a 3D grid → also gather vertically. Cap the top so we never trace cells
    // whose whole span sits well above the terrain (pure air, nothing to carve).
    const ckMin = Math.floor(y0 / cs) - gatherCells;
    const ckMax = Math.min(Math.floor(y1 / cs) + gatherCells, Math.floor(WORM_SEED_TOP_Y / cs));

    const out: number[] = [];
    for (let ck = ckMin; ck <= ckMax; ck++) {
      for (let cj = cjMin; cj <= cjMax; cj++) {
        for (let ci = ciMin; ci <= ciMax; ci++) {
          const pts = this.traceWormCell(ci, cj, ck);
          for (let i = 0; i < pts.length; i += 4) {
            const px = pts[i], py = pts[i + 1], pz = pts[i + 2];
            const pr = pts[i + 3] + wallSlop;   // include wall bulge in the overlap test
            // Keep spheres overlapping the chunk AABB (broad sphere-vs-box test per axis).
            if (px + pr < x0 || px - pr > x1) continue;
            if (py + pr < y0 || py - pr > y1) continue;
            if (pz + pr < z0 || pz - pr > z1) continue;
            out.push(px, py, pz, pts[i + 3]);   // store the true radius; wall added at test time
          }
        }
      }
    }
    this.chunkWormPts = new Float64Array(out);
    this.chunkWormPtsFor = key;
  }

  // ---- Caverns: large tall chambers on a spacing grid (warped ellipsoids) ----

  /**
   * Deterministically spawn every cavern for one 3D spawn-cell (ci,cj,ck) as a flat
   * [centerX, centerY, centerZ, horizRadius, …] Float64Array in world meters. Pure function of
   * (ci,cj,ck,seed) — every chunk that gathers this cell reproduces identical caverns → seamless.
   * Cached per cell. (ci→X, cj→Z, ck→Y, matching the worm grid.)
   */
  private traceCavernCell(ci: number, cj: number, ck: number): Float64Array {
    const cacheKey = ci + ',' + cj + ',' + ck;
    const cached = this.cavernCellCache.get(cacheKey);
    if (cached) return cached;

    const cave = this.config.caveConfig;
    const cs = cave.cavernCellSize;
    const seed = (this.config.seed + 60000) >>> 0;
    const rng = makeRng((hashInt2(hashInt2(ci, cj), ck) ^ seed) >>> 0);

    let n = Math.floor(cave.cavernsPerCell);
    if (rng() < cave.cavernsPerCell - n) n++;

    const out: number[] = [];
    for (let w = 0; w < n; w++) {
      const cx = (ci + rng()) * cs;   // X
      const cy = (ck + rng()) * cs;   // Y
      const cz = (cj + rng()) * cs;   // Z
      const rx = cave.cavernRadius * (1 + (rng() * 2 - 1) * cave.cavernRadiusJitter);
      out.push(cx, cy, cz, rx);
    }

    const arr = new Float64Array(out);
    if (this.cavernCellCache.size > 4096) this.cavernCellCache.clear();
    this.cavernCellCache.set(cacheKey, arr);
    return arr;
  }

  /**
   * Gather the caverns relevant to a chunk into `chunkCavernFeats` ([cx,cy,cz,rx,…]). Gathers every
   * spawn-cell within a cavern's maximum reach (vertical radius + winding warp + wall roughness) of
   * the chunk — a hard bound — then AABB-culls each cavern against the chunk. Seamless by
   * construction: adjacent chunks gather overlapping cells and see the same caverns.
   */
  private prepareChunkCaverns(cx: number, cy: number, cz: number): void {
    const key = cx + ',' + cy + ',' + cz;
    if (this.chunkCavernFeatsFor === key) return;

    const cave = this.config.caveConfig;
    const cs = cave.cavernCellSize;
    const x0 = cx * CHUNK_SIZE * VOXEL_SCALE, x1 = x0 + CHUNK_SIZE * VOXEL_SCALE;
    const z0 = cz * CHUNK_SIZE * VOXEL_SCALE, z1 = z0 + CHUNK_SIZE * VOXEL_SCALE;
    const y0 = cy * CHUNK_SIZE * VOXEL_SCALE, y1 = y0 + CHUNK_SIZE * VOXEL_SCALE;

    // Boundary can bulge out by the domain-warp amplitude (winding) + wall roughness — inflate the
    // gather + cull bounds by both or a cavern grazing the chunk edge would be dropped (a seam).
    const slop = cave.cavernWinding + cave.cavernWallAmp;
    const rxMax = cave.cavernRadius * (1 + cave.cavernRadiusJitter);
    const ryMax = rxMax * (1 + cave.cavernVerticality);
    const reach = ryMax + slop;
    const gatherCells = Math.ceil(reach / cs) + 1 + this.cavernGatherExtraCells;
    const ciMin = Math.floor(x0 / cs) - gatherCells, ciMax = Math.floor(x1 / cs) + gatherCells;
    const cjMin = Math.floor(z0 / cs) - gatherCells, cjMax = Math.floor(z1 / cs) + gatherCells;
    const ckMin = Math.floor(y0 / cs) - gatherCells;
    const ckMax = Math.min(Math.floor(y1 / cs) + gatherCells, Math.floor(CAVERN_SEED_TOP_Y / cs));

    const out: number[] = [];
    for (let ck = ckMin; ck <= ckMax; ck++) {
      for (let cj = cjMin; cj <= cjMax; cj++) {
        for (let ci = ciMin; ci <= ciMax; ci++) {
          const feats = this.traceCavernCell(ci, cj, ck);
          for (let i = 0; i < feats.length; i += 4) {
            const px = feats[i], py = feats[i + 1], pz = feats[i + 2], pr = feats[i + 3];
            const hExt = pr + slop;                          // horizontal half-extent
            const vExt = pr * (1 + cave.cavernVerticality) + slop; // vertical half-extent
            if (px + hExt < x0 || px - hExt > x1) continue;
            if (py + vExt < y0 || py - vExt > y1) continue;
            if (pz + hExt < z0 || pz - hExt > z1) continue;
            out.push(px, py, pz, pr);
          }
        }
      }
    }
    this.chunkCavernFeats = new Float64Array(out);
    this.chunkCavernFeatsFor = key;
  }

  /**
   * Cavern fill at a world voxel: 0 = solid (outside / stalagmite / stalactite), 1 = air,
   * 2 = water. Scans the prepared caverns; each is a warped ellipsoid (domain warp = winding, plus
   * per-voxel wall roughness). Inside a cavern, the bottom fills with water up to a flat level and
   * hashed conical spikes rise from the floor / hang from the ceiling. Across overlapping caverns the
   * most-open result wins (air > water > solid). Pure function of position → seamless.
   */
  private sampleCavern(x: number, y: number, z: number, surfaceMeters: number): 0 | 1 | 2 {
    const feats = this.chunkCavernFeats;
    if (feats.length === 0) return 0;
    const cave = this.config.caveConfig;
    const vert = cave.cavernVerticality;
    // Surface taper: narrow (but never seal) cavern tops that breach the surface. `cavernTerrainTaper`
    // is a 0..1 amount — at the surface the boundary shrinks toward CAVERN_TAPER_MIN_FRAC of full
    // radius as taper→1, easing back to full radius CAVERN_TAPER_BAND m below. taper=0 → no narrowing.
    const taperAmt = cave.cavernTerrainTaper > 0 ? Math.min(1, cave.cavernTerrainTaper) : 0;
    let taper = 1;
    if (taperAmt > 0) {
      const surfaceFactor = 1 - taperAmt * (1 - CAVERN_TAPER_MIN_FRAC);
      const t = Math.max(0, Math.min(1, (surfaceMeters - y) / CAVERN_TAPER_BAND));
      taper = surfaceFactor + (1 - surfaceFactor) * t;
    }

    // Domain warp (winding) — displace the sample point; clean ellipsoid when winding = 0.
    let wx = x, wy = y, wz = z;
    if (cave.cavernWinding > 0) {
      const a = cave.cavernWinding;
      wx += this.caveCavernWarpX.GetNoise(x, y, z) * a;
      wy += this.caveCavernWarpY.GetNoise(x, y, z) * a;
      wz += this.caveCavernWarpZ.GetNoise(x, y, z) * a;
    }
    // Wall roughness (meters) — a signed radius bump; 0 when wall amp = 0.
    const wallMeters = cave.cavernWallAmp > 0 ? this.caveCavernWall.GetNoise(x, y, z) * cave.cavernWallAmp : 0;

    let best = -1; // priority: 2 = air, 1 = water, 0 = solid; -1 = not inside any cavern
    for (let i = 0; i < feats.length; i += 4) {
      const cx = feats[i], cy = feats[i + 1], cz = feats[i + 2], rx = feats[i + 3];
      const ry = rx * (1 + vert), rz = rx;
      const dx = wx - cx, dy = wy - cy, dz = wz - cz;
      const ndx = dx / rx, ndy = dy / ry, ndz = dz / rz;
      const nd = Math.sqrt(ndx * ndx + ndy * ndy + ndz * ndz);
      if (nd >= taper * (1 + wallMeters / rx)) continue;  // outside the (rough, surface-tapered) boundary

      // Vertical span of the ellipsoid at this column → the local floor / ceiling world-Y.
      const rh2 = ndx * ndx + ndz * ndz;
      const vspan = ry * Math.sqrt(Math.max(0, 1 - rh2));
      const floorY = cy - vspan;
      const ceilY = cy + vspan;
      // Flat water surface for this chamber (fraction of full height from the bottom).
      const waterY = (cy - ry) + cave.cavernWaterLevel * 2 * ry;

      let fill: number;
      if (cave.cavernWaterLevel > 0 && y < waterY) {
        fill = 1; // water (priority 1)
      } else if (this.cavernSpikeSolid(x, z, y, floorY, ceilY)) {
        fill = 0; // stalagmite / stalactite (solid)
      } else {
        fill = 2; // open air (priority 2)
      }
      if (fill > best) best = fill;
    }

    if (best < 0) return 0;
    return best === 2 ? 1 : best === 1 ? 2 : 0;  // priority → fill code
  }

  /**
   * Is this voxel inside a stalagmite (rising from the cavern floor) or stalactite (hanging from the
   * ceiling)? A hashed 2D XZ grid places at most one conical spike per cell; each is a pure function
   * of its cell → seamless. Height/radius/abundance scale with cavernSpikeAmount.
   */
  private cavernSpikeSolid(x: number, z: number, y: number, floorY: number, ceilY: number): boolean {
    const amount = this.config.caveConfig.cavernSpikeAmount;
    if (amount <= 0) return false;
    const cell = CAVERN_SPIKE_CELL;
    const scx = Math.floor(x / cell), scz = Math.floor(z / cell);
    const seed = (this.config.seed + 70000) >>> 0;
    const rng = makeRng((hashInt2(hashInt2(scx, scz), seed)) >>> 0);
    if (rng() > amount) return false;                 // this cell has no spike
    const fx = (scx + rng()) * cell, fz = (scz + rng()) * cell;
    const ddx = x - fx, ddz = z - fz;
    const distXZ = Math.sqrt(ddx * ddx + ddz * ddz);
    const baseR = CAVERN_SPIKE_MAX_R * (0.5 + 0.5 * rng());
    if (distXZ >= baseR) return false;
    const peakH = CAVERN_SPIKE_MAX_H * amount * (0.4 + 0.6 * rng());
    const coneH = peakH * (1 - distXZ / baseR);
    const stalactite = rng() < 0.5;
    return stalactite
      ? (ceilY - y) >= 0 && ceilY - y < coneH
      : (y - floorY) >= 0 && y - floorY < coneH;
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
   * Used for gradual dipping effect.
   * Uses 4 cardinal directions with coarse stepping (~4 noise calls per direction)
   * instead of 8 directions × 15 fine steps.
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
    
    const eps = 0.001;
    let minEdgeDist = halfWidth;
    
    // 4 cardinal directions with coarse step size (~4 samples per direction)
    const step = Math.max(0.3, halfWidth / 4);
    const directions: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    
    for (const [dx, dz] of directions) {
      for (let dist = step; dist <= halfWidth; dist += step) {
        const [wx, wz] = this.applyPathwayWarp(worldX + dx * dist, worldZ + dz * dist);
        const cell = this.pathwayCellular.GetNoise(wx, wz);
        
        if (Math.abs(centerCell - cell) > eps) {
          minEdgeDist = Math.min(minEdgeDist, dist);
          break;
        }
      }
    }
    
    // Convert distance to cell boundary into depth factor
    // minEdgeDist is SMALL near edge, LARGE at center
    // We want depth factor to be 1 at center, 0 at edge, so invert
    const t = 1 - Math.min(1, minEdgeDist / halfWidth);
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
    
    // Determine surface material.
    // Height stays at the dipped terrain floor — liquid/transparent fills
    // (water) sit above it but shouldn't raise the reported height, otherwise
    // getChunkRangeFromHeights may skip the chunk containing the actual solid surface.
    const waterConfig = this.config.pathwayConfig;
    if (waterConfig.waterEnabled && isPath && pathDipAmount > 0) {
      material = waterConfig.waterMaterial;
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
   * @returns Uint32Array of packed voxel data (CHUNK_SIZE^3 elements)
   */
  generateChunk(cx: number, cy: number, cz: number): Uint32Array {
    const data = new Uint32Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);

    // Calculate chunk's world origin
    const chunkWorldX = cx * CHUNK_SIZE * VOXEL_SCALE;
    const chunkWorldY = cy * CHUNK_SIZE; // Y is in voxels for height comparison
    const chunkWorldZ = cz * CHUNK_SIZE * VOXEL_SCALE;

    // Gather+trace the caves relevant to this chunk once, before any per-voxel carve test. Both
    // types are independent, so prepare whichever are enabled (they combine in caveFillAt).
    const cave = this.config.caveConfig;
    const anyCave = cave.wormsEnabled || cave.cavernsEnabled;
    if (cave.wormsEnabled) this.prepareChunkWorms(cx, cy, cz);
    if (cave.cavernsEnabled) this.prepareChunkCaverns(cx, cy, cz);

    // Terrain layer OFF → skip the base landscape, pathways, and stamps entirely. Any enabled cave
    // layer is rendered as SOLID casts in otherwise-empty space so the raw cave shapes can be
    // inspected; with no caves either, the chunk is empty air.
    if (!this.config.terrainLayer.enabled) {
      return anyCave
        ? this.generateCaveCastChunk(data, chunkWorldX, chunkWorldY, chunkWorldZ)
        : data;
    }

    // Whether any column in this chunk is on a pathway — a free early-out that gates the
    // (otherwise per-column) pathway-wall torch scan so empty chunks pay nothing for it.
    let chunkHasPath = false;

    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        // Calculate world position for this column
        const worldX = chunkWorldX + lx * VOXEL_SCALE;
        const worldZ = chunkWorldZ + lz * VOXEL_SCALE;

        // Sample terrain height at this XZ position
        let terrainHeight = this.sampleHeight(worldX, worldZ);

        // Cache pathway checks for this column (only depends on X/Z)
        const isPathColumn = this.isOnPathway(worldX, worldZ);
        if (isPathColumn) chunkHasPath = true;
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
          
          // Carve caves out of solid terrain. Pure function of world position → seamless across
          // chunks. Gated on solid, non-water, non-wall voxels so the open air above the surface and
          // the path furniture are skipped (keeps it cheap). Worms/caverns combine in caveFillAt:
          // 1 = air (carve), 2 = water (cavern pool), 0 = leave terrain (outside / spike).
          if (anyCave
              && finalWeight > -0.5
              && material !== waterConfig.waterMaterial
              && material !== this.config.pathwayConfig.wallMaterial) {
            const fill = this.caveFillAt(worldX, voxelY * VOXEL_SCALE, worldZ, terrainHeight * VOXEL_SCALE);
            if (fill === 1) {
              finalWeight = -0.5;
              material = 0; // air
            } else if (fill === 2) {
              finalWeight = 0.5; // solid body of water; flat top where it meets the cavern air above
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

    // Torches along the cobble pathway walls (the walls that line the water-filled paths).
    // Gated on chunkHasPath so the per-column scan only runs where a path actually is.
    if (this.stampPlacer && chunkHasPath) {
      const torchPlacements = this.generatePathwayWallTorches(cx, cz);
      if (torchPlacements.length > 0) {
        this.stampPlacer.applyStamps(data, cx, cy, cz, torchPlacements, this);
      }
    }

    return data;
  }

  /**
   * Cave-cast generator (Terrain layer OFF): fill a chunk with SOLID rock exactly where the enabled
   * cave layers would carve air/water, and leave everything else empty. The result is a faithful
   * "negative" — fly around and see the tunnel / chamber casts sitting where the ground used to be,
   * with no other terrain, pathways, or stamps in the way.
   */
  private generateCaveCastChunk(data: Uint32Array, chunkWorldX: number, chunkWorldY: number, chunkWorldZ: number): Uint32Array {
    const solidMaterial = mat('rock');
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const worldX = chunkWorldX + lx * VOXEL_SCALE;
        const worldZ = chunkWorldZ + lz * VOXEL_SCALE;
        const terrainHeight = this.sampleHeight(worldX, worldZ);

        for (let ly = 0; ly < CHUNK_SIZE; ly++) {
          const voxelY = chunkWorldY + ly;

          let finalWeight = -0.5; // air
          let material = 0;
          if (this.isInsideCave(worldX, voxelY * VOXEL_SCALE, worldZ, terrainHeight * VOXEL_SCALE)) {
            finalWeight = 0.5; // solid cave cast
            material = solidMaterial;
          }

          const index = lx + ly * CHUNK_SIZE + lz * CHUNK_SIZE * CHUNK_SIZE;
          data[index] = packVoxel(finalWeight, material, 0);
        }
      }
    }
    return data;
  }

  // Pathway-wall torches: scan every wall column in the chunk (+ a small margin so torches
  // straddling a chunk edge are emitted — and per-voxel culled — by every chunk they touch), and
  // keep ~1 in TORCH_STRIDE via a per-column hash. Deterministic and seam-safe: each column decides
  // identically from any chunk that sees it. Walls are dense along the sparse cobble paths, so this
  // yields a visible run of torches where the old grid-snap found almost none.
  private static readonly TORCH_MARGIN_VOX = 3;
  private static readonly TORCH_STRIDE = 56;

  /**
   * Deterministic pathway-wall torch placements overlapping chunk (cx,cz), seated on the wall top
   * via `yOffset = wallHeight`. One torch per ~TORCH_STRIDE wall columns.
   */
  private generatePathwayWallTorches(cx: number, cz: number): StampPlacement[] {
    const cfg = this.config.pathwayConfig;
    if (!cfg.enabled || cfg.wallHeight <= 0) return [];

    const out: StampPlacement[] = [];
    const M = TerrainGenerator.TORCH_MARGIN_VOX;
    const stride = TerrainGenerator.TORCH_STRIDE;
    const seedBase = (this.config.seed + 20000) >>> 0;
    const baseVoxX = cx * CHUNK_SIZE;
    const baseVoxZ = cz * CHUNK_SIZE;

    for (let lz = -M; lz < CHUNK_SIZE + M; lz++) {
      for (let lx = -M; lx < CHUNK_SIZE + M; lx++) {
        const wvx = baseVoxX + lx;
        const wvz = baseVoxZ + lz;
        // Cheap hash gate first — most wall columns are skipped without the noise sampling.
        if (((hashInt2(wvx, wvz) ^ seedBase) >>> 0) % stride !== 0) continue;
        const worldX = wvx * VOXEL_SCALE;
        const worldZ = wvz * VOXEL_SCALE;
        if (!this.isOnPathwayWall(worldX, worldZ)) continue;
        out.push({
          type: StampType.TORCH, variant: 0,
          worldX, worldZ, rotation: 0,
          yOffset: cfg.wallHeight,
        });
      }
    }
    return out;
  }
}
