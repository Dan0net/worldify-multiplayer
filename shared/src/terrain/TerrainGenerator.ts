/**
 * Terrain generation framework
 * Generates chunk voxel data using layered noise functions with domain warping
 */

import FastNoiseLite from 'fastnoise-lite';
import { CHUNK_SIZE, VOXEL_SCALE } from '../voxel/constants.js';
import { packVoxel } from '../voxel/voxelData.js';
import { mat } from '../materials/index.js';
import { smoothstep } from '../util/math.js';
import { Curve, type CurvePoint } from './Curve.js';
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
  /** Paths toggle: the base landscape + pathways (roads / walls / torches). */
  enabled: boolean;
  /** Stamps toggle: scattered trees / rocks / buildings. Separate from paths so "Paths" is just paths. */
  stampsEnabled: boolean;
  /**
   * WORLD-level feature scale, applied to EVERY generation type (land, rivers, paths, caves, and
   * building/stamp spacing). Bigger = larger features everywhere (the world stretched uniformly);
   * implemented as a coordinate/frequency divisor + a matching vertical scale on the landform. 1 =
   * identity (byte-identical to a world without the knob), so existing worlds are unaffected.
   */
  masterScale: number;
  /**
   * LAND feature scale, composed on top of masterScale for the landform + rivers only (not paths,
   * caves, or buildings). Lets you dial land size independently, then scale the whole world with
   * masterScale. 1 = identity.
   */
  landScale: number;
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

  // ---- Landform layer (sea / beach / plains / mountains) — a macro elevation model that reshapes the
  // base terrain height. Its own toggle, but nested here since it only shapes the terrain layer's height.
  /** Master toggle for the landform elevation model (sea / beach / snow / rock / grass surface + height). */
  landformEnabled: boolean;
  /** Fraction of the world that is ocean, 0..~90 (%). Sets the sea crossing by percentile of the
   *  continental noise, so it's an intuitive sea:land ratio independent of the curve/scale. */
  seaCoveragePercent: number;
  /** Feature scale — multiplies the continental base frequency. Higher = smaller, more compact land/sea. */
  landformScale: number;
  /** Coast-warp scale RELATIVE to the base scale (warp frequency = base × this). >1 = finer than the land. */
  landformWarpScale: number;
  /** Coast-warp amplitude in meters — how far the warp bends coastlines / mountain fronts (sweeping). */
  landformWarpStrength: number;
  /** Sea level in voxels. Columns whose land is below this flood with water up to it. */
  landformSeaLevel: number;
  /** Depth in voxels of the deepest ocean floor below sea level. */
  landformSeaDepth: number;
  /** Max mountain peak height in voxels ABOVE sea level (the top of the elevation curve). */
  landformMountainHeight: number;
  /** Height in voxels the flat sand beach sits above sea level (it drops off sharply at the waterline). */
  landformBeachWidth: number;
  /** Elevation in voxels (above sea) beyond which mountain tops turn to snow. */
  landformSnowLine: number;

  // ---- Elevation curve (replaces the hardcoded shelf/beach/plains/mountain step function). Control
  // points map the continental noise (x: 0..1) to a height OFFSET in voxels relative to sea level
  // (y). A monotone cubic spline (see Curve) interpolates them with no overshoot, so the sea→beach
  // transition is a soft ramp you can shape in the panel. Empty → the built-in default curve.
  /** Elevation curve control points (noise 0..1 → voxels above/below sea). Empty = default curve. */
  landformCurve: CurvePoint[];

  // ---- Detail + slope (LandLayer surface texture). Detail frequency is relative to the land scale
  // so it tracks feature size; amplitude is driven by slope (steep = jagged) with a small floor on
  // flats. Slope also drives grass→rock material and the stamp steepness cull.
  /** Surface-detail noise frequency multiplier (relative to the land base frequency). */
  landformDetailFrequency: number;
  /** Surface-detail amplitude in voxels on flat ground (the floor so plains aren't glassy). */
  landformDetailFlat: number;
  /** Additional surface-detail amplitude in voxels at maximum slope (steep = more jagged/bumpy). */
  landformDetailSteep: number;
  /** Slope in degrees at which the surface fully turns from grass to rock (blend starts at ~half this). */
  landformRockSlopeDeg: number;

  // ---- Rivers (natural water channels). HYDROLOGY: sources are seeded on highland and traced DOWNHILL
  // along the heightmap gradient, so channels lie in valleys, merge, and reach the sea. Drawn separately
  // from paths. (Scales with the world like the rest of the land.)
  /** Master toggle for rivers. Independent of paths/buildings. */
  riversEnabled: boolean;
  /** Channel width in meters at the SOURCE (head). */
  riverStartWidth: number;
  /** Channel width in meters at the MOUTH; width lerps start→end along the river. */
  riverEndWidth: number;
  /** River channel depth in voxels (how far the bed dips below the surrounding land). */
  riverDepth: number;
  /** Spacing in meters between candidate river sources (hashed grid; larger = fewer rivers). */
  riverSourceSpacing: number;
  /** Minimum source elevation as a fraction (0..1) of the mountain height above sea — only highland
   *  columns spawn a river head, so sources sit near valley tops. */
  riverSourceMinElevation: number;
  /** Lateral meander strength (0 = straight downhill; higher = snakier channels). */
  riverMeander: number;
  /** Maximum length a river is traced, in meters, before it is cut off (bounds the per-chunk gather). */
  riverMaxLength: number;
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

/**
 * Steering-noise sample stride for the worm trace. The trace advances ~1.2 m per step while the steering
 * fields are low frequency (steerFrequency 0.05 → ~20 m period), so evaluating all three GetNoise every
 * step is heavy oversampling and dominates the one-time worm cold-start. We sample once per this many
 * steps (~19 m at 16) and, on the default turnRate = 1 path, INTERPOLATE the heading between samples so
 * worms curve smoothly rather than kink — letting the stride be large (few noise reads) without faceted
 * tunnels. The trace is a chaotic integrator, so this DOES change worm layout (new seed-worlds get
 * different — but equally valid — tunnels); saved worlds keep their persisted chunks. */
const WORM_TRACE_SUBSAMPLE = 16;

/** Caverns only seed at or below this world Y (meters) — like WORM_SEED_TOP_Y — so chambers form
 *  under the terrain, not floating in the sky. */
const CAVERN_SEED_TOP_Y = 8;
/** Stalagmite/stalactite hash-grid spacing in meters (one candidate spike per XZ cell). */
const CAVERN_SPIKE_CELL = 4;
/** Max stalagmite/stalactite height in meters. NOTE: height is deliberately NOT scaled by
 *  cavernSpikeAmount (that only gates how many cells get a spike) — otherwise a low amount made spikes
 *  both rare AND tiny, which is why they were invisible for so long. */
const CAVERN_SPIKE_MAX_H = 7;
/** Base radius as a fraction of a spike's height (cone aspect) + a floor, so tall spikes read as cones
 *  rather than needles. baseR up to ~2.3 m can cross a 4 m cell, hence the 3×3 neighbour scan. */
const CAVERN_SPIKE_BASE_RATIO = 0.33;
const CAVERN_SPIKE_MIN_R = 0.8;
/** The 4 cardinal step directions for the pathway edge scan — module const so it isn't reallocated
 *  per pathway-depth query. */
const PATH_CARDINALS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Cavern domain-warp lattice corners per axis over the chunk cube (CHUNK_SIZE·VOXEL_SCALE = 8 m).
 *  9 corners → 1 m spacing; the warp's ~33 m period makes this far finer than the field varies. */
const CAVERN_WARP_LATTICE_N = 2;

/** Meters below the surface over which a surface-tapered cavern widens back to full radius. */
const CAVERN_TAPER_BAND = 24;
/** Tightest surface opening as a fraction of full radius at cavernTerrainTaper = 1 (still breaches). */
const CAVERN_TAPER_MIN_FRAC = 0.15;

// ============== Default Cave Configuration ==============

export const DEFAULT_CAVE_CONFIG: CaveConfig = {
  wormsEnabled: true,       // traced worms on by default
  cavernsEnabled: true,     // caverns on by default too — worms + caverns combined
  floorY: undefined,        // no hard floor by default

  // Worms (traced tunnels). Seeded on a 3D grid so they fill the whole depth from just above the
  // surface downward.
  wormCellSize: 40,         // 40 m spawn cells (3D grid)
  wormsPerCell: 2.0,        // worms per 3D cell
  wormSegments: 120,        // long worms (120 × 1.5 m = 180 m) — fewer, larger steps than the
  wormStep: 1.5,            // old 150×1.2; ~20% fewer trace steps/noise, still overlapping (r≈2 m)
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

  // Caverns (large tall chambers), dialled in to combine with worms: winding, rough walls, varied
  // sizes, spaced moderately, tops narrowed where they breach the surface.
  cavernCellSize: 60,       // 60 m spawn cells
  cavernsPerCell: 1.0,      // ~one cavern per cell
  cavernRadius: 10,         // 10 m base horizontal radius
  cavernRadiusJitter: 0.5,  // ±50% size variety between caverns
  cavernVerticality: 1.0,   // vertical radius ≈ 2× horizontal
  cavernWinding: 20,        // strong domain warp → organic, lobed walls
  cavernWallAmp: 2,         // 2 m wall roughness
  cavernWallFrequency: 0.3, // wall-bump scale
  cavernWarpFrequency: 0.03,// domain-warp scale
  cavernWaterLevel: 0.1,    // shallow water pool in the bottom
  cavernSpikeAmount: 0.5,   // fraction of spike cells that get a stalagmite/stalactite (full-height)
  cavernTerrainTaper: 0.4,  // narrow surface breaches (still open)
};

// ============== Default Terrain Layer Configuration ==============

/**
 * Default elevation curve, expressed as (noise 0..1 → voxels relative to sea level). Reproduces the
 * old ocean-shelf / beach / plains / mountain shape but with a SOFT sea→beach transition (the old
 * hardcoded curve had a hard step at the waterline that z-fought the water shader). Scaled by
 * mountainHeight/seaDepth/beachWidth at eval time, so the shape is authored once and the config
 * knobs stretch it. Height OFFSET so it's independent of sea level.
 */
// NOTE on x placement: the continental noise is FBm, whose values cluster near the middle — u rarely
// exceeds ~0.85. So the mountain ramp + plateau MUST live in the reachable band (peaks by ~u 0.82),
// or mountains/snow essentially never appear. The ocean descent is spread across the whole u<0.5 tail
// so the seabed is a gradual slope, not a cliff off the beach.
export const DEFAULT_LANDFORM_CURVE: CurvePoint[] = [
  { x: 0.00, y: -1.00 },   // deepest ocean floor (× seaDepth)
  { x: 0.10, y: -1.00 },   // PLATEAU: flat deep sea floor across the bottom of the range
  { x: 0.24, y: -0.50 },   // gradual rise…
  { x: 0.34, y: -0.15 },
  { x: 0.40, y: 0.00 },    // waterline moved LEFT → ~30% sea (much less), more land
  { x: 0.45, y: 0.03 },    // gentle sand beach
  { x: 0.53, y: 0.10 },    // grass plains
  { x: 0.63, y: 0.24 },    // hills — big mountainous band begins low so mountains are common
  { x: 0.73, y: 0.46 },    // low mountains (climbable grade, rugged via detail)
  { x: 0.83, y: 0.72 },    // mountains (snow line ~ here)
  { x: 0.92, y: 0.93 },    // upper slopes
  { x: 1.00, y: 1.00 },    // plateau: flat snowy peak tops
];

export const DEFAULT_TERRAIN_LAYER_CONFIG: TerrainLayerConfig = {
  enabled: true,            // base landscape + pathways on by default
  stampsEnabled: true,      // trees / rocks / buildings on by default
  masterScale: 1,           // world feature scale (1 = identity → existing worlds unchanged)
  landScale: 1,             // land feature scale, on top of masterScale (1 = identity)
  pathSpacing: 160,         // ~160 m between path cells
  pathWidth: 6.0,           // 6 m roads
  pathWarpAmplitude: 30,    // gentle meander
  pathWarpFrequency: 0.006, // broad curves
  buildingSpacing: 50,      // largest building grid

  // Landform layer — OFF by default so existing worlds/the current terrain are byte-identical.
  landformEnabled: false,
  seaCoveragePercent: 10,      // ~10% ocean by default (percentile of the continental noise)
  landformScale: 1.8,          // larger, gentler features (~460 m landmasses) so slopes are climbable
  landformWarpScale: 1.0,      // warp at the land frequency
  landformWarpStrength: 50,    // metres of coast warp → sweeping coasts/ranges
  landformSeaLevel: 40,        // voxels (~10 m)
  landformSeaDepth: 100,       // voxels (~25 m) — shallower ocean with a flat floor
  landformMountainHeight: 180, // voxels (~45 m) peaks above sea level (shorter → climbable slopes)
  landformBeachWidth: 10,      // voxels the flat beach sits above sea
  landformSnowLine: 90,        // voxels above sea → snow caps (well below mountainHeight → more snow)
  landformCurve: DEFAULT_LANDFORM_CURVE,

  landformDetailFrequency: 10, // ×0.03/m absolute → ~3 m base rubble (+ finer octaves)
  landformDetailFlat: 0.2,     // slight texture on flat ground so plains aren't glassy
  landformDetailSteep: 20,     // strong rubble amplitude that ramps in (squared) toward vertical slopes
  landformRockSlopeDeg: 30,    // rock shows from ~30° (shallower — rocky hillsides, not just cliffs)

  riversEnabled: false,        // rivers off by default (opt-in landform feature)
  riverStartWidth: 5,          // 5 m at the head
  riverEndWidth: 15,           // 15 m at the mouth
  riverDepth: 8,               // 8 voxels deep beds
  riverSourceSpacing: 50,      // ~50 m between candidate river heads
  riverSourceMinElevation: 0.4, // only seed sources on the upper 60% of the mountain height
  riverMeander: 0.5,           // moderate snaking
  riverMaxLength: 600,         // trace up to 600 m downhill
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
    octaves: 1,   // 1 octave: the warp is a low-freq organic wiggle; the 2nd octave was fine detail
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

/** Depth (voxels) of the landform surface skin that gets sand/snow/gravel; below it, normal rock strata. */
const LANDFORM_SKIN_DEPTH = 3;
/** Landform continental base frequency (1/m) at landformScale = 1; the config scale multiplies it. */
export const LANDFORM_BASE_FREQ = 0.0012;
/** Minimum beach band + river depth in voxels — feature sizes are floored here so uniform world
 *  down-scaling (small masterScale) can't shrink them below the fixed voxel resolution and vanish. */
const MIN_BEACH_VOXELS = 3;
const MIN_RIVER_DEPTH = 3;
/** Surface-detail base frequency (1/m) at detailFrequency = 1 — an ABSOLUTE rubble scale, independent
 *  of the (very low) continental frequency, so detail can be fine rocks/rubble rather than broad bumps. */
const LANDFORM_DETAIL_BASE_FREQ = 0.03;

/** Lazily-filled per-column memo of the pathway predicates (each computed on first demand). */
interface PathwayColumnInfo {
  onPath?: boolean;
  onWall?: boolean;
  onBorder?: boolean;
  depth?: number;
  material?: number;
  centerCell?: number;   // warped cellular value AT this column — shared by every pathway predicate
  // River (traced hydrology): the FLAT water surface + carved bed at this column. -Inf / +Inf when the
  // column is off any channel. Computed together, memoized per column.
  riverWater?: number;   // flat water-surface height (voxels); -Infinity off-river
  riverBed?: number;     // carved channel-bed height (voxels); +Infinity off-river
}

export class TerrainGenerator implements HeightSampler {
  private config: TerrainConfig;
  private heightNoise: FastNoiseLite;
  private warpNoiseX: FastNoiseLite;
  private warpNoiseZ: FastNoiseLite;

  // Landform system (sea/beach/plains/mountains). Seed block config.seed + 50000 so it never perturbs
  // the base-terrain seed++ chain — with landformEnabled off, existing output stays byte-identical.
  private landformWarpX: FastNoiseLite;   // strong large-scale domain warp (sweeping coasts)
  private landformWarpZ: FastNoiseLite;
  private landformBase: FastNoiseLite;    // one low-freq continental fBm → the landmass shape
  private landformDetail: FastNoiseLite;  // dedicated surface-detail fBm (own explicit frequency)
  // Compiled elevation curve (built from config.landformCurve). Maps continental noise 0..1 → a height
  // offset relative to sea level; scaled by the seaDepth/mountainHeight/beachWidth knobs at eval time.
  private landformCurveFn: Curve = new Curve(DEFAULT_LANDFORM_CURVE);
  private seaU0 = 0.5;          // curve input where the elevation offset crosses sea level
  private seaUThreshold = 0.5;  // noise percentile (curve-input space) that should map to the sea crossing

  // Rivers — HYDROLOGY: sources seeded on highland, traced downhill along the heightmap gradient. One
  // low-frequency noise supplies the lateral meander; seeded in a separate block (+80000) so it never
  // perturbs the base seed chain. Traced polylines are cached per source cell + gathered per chunk.
  private riverMeanderNoise: FastNoiseLite;
  // Traced polyline per source cell (packed key → {pts:[x0,z0,…], bbox:[minx,minz,maxx,maxz]}); empty
  // pts means the source cell isn't highland (no river). Gathered segments per chunk key for the query.
  private riverCellCache = new Map<number, { pts: Float32Array; bbox: Float32Array }>();
  private riverSegCache = new Map<number, Float32Array>();

  // Pathway system - cellular noise with domain warping
  private pathwayCellular: FastNoiseLite;
  private pathwayWarpX: FastNoiseLite;
  private pathwayWarpZ: FastNoiseLite;
  private pathwayMaterialNoise: FastNoiseLite;

  // Un-scaled snapshot of the merged cave config. masterScale is baked into `config.caveConfig`
  // (spatial fields × scale, frequencies ÷ scale) from THIS snapshot every time config/scale changes,
  // so re-applying config never double-bakes. At masterScale = 1 the baked values equal the raw ones.
  private rawCaveConfig!: CaveConfig;
  // Un-scaled snapshot of the merged pathway config. masterScale is baked into config.pathwayConfig
  // from this each time applyTerrainLayer runs, so re-applying never double-scales.
  private rawPathwayConfig!: PathwayConfig;

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
  // Keyed by a packed INTEGER cell id (see cellKey) — string keys made the per-cell Map.get + key
  // concatenation the hottest lines in the worm gather. Each entry holds the sphere list AND its
  // sphere-cloud AABB [minX,minY,minZ,maxX,maxY,maxZ] (inflated per sphere by radius+wallSlop), so the
  // gather does ONE lookup per cell and skips the whole list with a single box test when it can't reach
  // the chunk — the cull loop was its dominant cost.
  private wormCellCache = new Map<number, { pts: Float64Array; bbox: Float64Array }>();
  private chunkWormPts: Float64Array = new Float64Array(0);
  private chunkWormPtsFor = -1;

  // Cavern state: caverns cached per spawn cell, and the descriptors ([cx,cy,cz,rx,…] in world
  // meters) relevant to the chunk currently being generated.
  private cavernCellCache = new Map<number, Float64Array>();
  private chunkCavernFeats: Float64Array = new Float64Array(0);
  private chunkCavernFeatsFor = -1;

  // Per-chunk cavern domain-warp lattice: the winding warp is very low frequency (~33 m period) yet
  // was evaluated per 0.25 m voxel (3 GetNoise) — ~57% of cavern gen. Precompute the 3 warp noises on
  // a coarse lattice over the chunk cube once, then trilinearly interpolate per voxel. `cavernWarpLat`
  // holds [nX,nY,nZ] per corner (raw noise); origin/step in world metres. Built by prepareChunkCaverns.
  private cavernWarpLat: Float64Array | null = null;
  private cavernWarpOx = 0; private cavernWarpOy = 0; private cavernWarpOz = 0;

  // Per-(cx,cz)-tile set of columns (lx + lz*CHUNK_SIZE) where a cave breaches the surface — used to
  // suppress surface features (stamps + pathways) over cave openings. Cached per tile in a bounded
  // map (not a single entry) so a chunk's stamp filter can consult neighbouring tiles — a stamp whose
  // origin sits in an adjacent tile must be suppressed by that tile's breaches — without cache thrash.
  private breachColsCache = new Map<number, Set<number>>();

  // Per-column 2D surface height, memoized so a vertical stack of chunks (same cx,cz, different cy)
  // doesn't recompute the ~9-noise height field per cy. Keyed by EXACT world (x,z): grid queries across
  // cy use identical floats so they hit; off-grid callers (spawn/collision) miss and recompute exactly,
  // so results are unchanged. Cleared on any config/seed change (invalidateCaveCaches).
  private heightCache = new Map<number, Map<number, number>>();
  private heightCacheEntries = 0;

  // Per-column landform slope (tan of the surface angle), memoized like heightCache. Drives detail
  // amplitude (steep = jagged) AND the grass→rock material blend AND the stamp steepness cull, so it's
  // computed once per column and shared. Only used when landformEnabled. Cleared with the height memo.
  private slopeCache = new Map<number, Map<number, number>>();
  private slopeCacheEntries = 0;
  // Per-column POST-detail slope angle (degrees): slope of the actual rendered surface INCLUDING the
  // rubble detail, so the grass→rock test reads the jagged detailed faces (not just the smooth macro
  // grade). Safe from the old aliasing because the detail wavelength is floored (updateLandformConfig).
  private detailSlopeCache = new Map<number, Map<number, number>>();
  private detailSlopeCacheEntries = 0;


  // Per-(worldX,worldZ)-column memo of the pathway (road) queries. Pathways are XZ-only but were
  // re-evaluated per query type AND per cy chunk in a column — each doing domain warp + several
  // cellular samples — making them the single biggest noise-call source (≈77% of warm cave gen).
  // Caching the 5 predicates per column (computed lazily, reused across cy and across callers) is
  // byte-identical and collapses that cost. Bounded like heightCache.
  private pathwayCache = new Map<number, Map<number, PathwayColumnInfo>>();
  private pathwayCacheEntries = 0;

  // Per-(cx,cz) FILTERED stamp placements, memoized so the 25-neighbour scatter + O(n²) collision +
  // pathway/breach filter isn't recomputed for every cy in a column (the result is XZ-only). Bounded;
  // cleared on config/seed change.
  private placementCache = new Map<number, StampPlacement[]>();

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
      // Stamps used to be gated by `enabled` (the old Buildings layer) — worlds predating the split
      // inherit stampsEnabled from it so trees/rocks/buildings stay exactly as before.
      if (config.terrainLayer.stampsEnabled === undefined) this.config.terrainLayer.stampsEnabled = this.config.terrainLayer.enabled;
    }
    // Snapshot the un-scaled cave + pathway configs, then bake masterScale into config.caveConfig.
    this.rawCaveConfig = { ...this.config.caveConfig };
    this.rawPathwayConfig = { ...this.config.pathwayConfig };
    this.applyMasterScaleToCaves();
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
    this.pathwayWarpX.SetFractalOctaves(1);   // 1 octave — path curves are large-scale; fine warp detail is wasted
    
    this.pathwayWarpZ = new FastNoiseLite(seed++);
    this.pathwayWarpZ.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    this.pathwayWarpZ.SetFractalOctaves(1);
    
    // Pathway material selection noise - low frequency for gradual material transitions
    this.pathwayMaterialNoise = new FastNoiseLite(seed++);
    this.pathwayMaterialNoise.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    
    this.updatePathwayConfig();

    // Cave noise — fixed seed block (config.seed + 30000+) so the seed++ chain above is untouched.
    // All generators are built up-front (cheap); only the enabled types are sampled per voxel.
    let caveSeed = this.config.seed + 30000;
    // Worms: two 3D fields steer each worm's heading (yaw + pitch) as it's traced. Single-octave
    // OpenSimplex2 (not 2-octave FBm): these are low-frequency flow fields sampled only every K steps and
    // then interpolated, so the 2nd octave's fine wobble is smoothed away regardless — but on device it
    // doubled the steering-noise cost (the trace's dominant expense). One octave = same gross flow,
    // roughly half the noise work. Worm layout shifts slightly (equally valid); saved worlds unaffected.
    this.caveWormSteerYaw = new FastNoiseLite(caveSeed++);
    this.caveWormSteerYaw.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    this.caveWormSteerPitch = new FastNoiseLite(caveSeed++);
    this.caveWormSteerPitch.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
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

    // Landform noise (seed block +50000, kept off the base seed++ chain — see field decls).
    let landformSeed = this.config.seed + 50000;
    // Warp: FBm with 2 octaves (was single) so coastlines/ranges get an extra layer of meander detail.
    this.landformWarpX = new FastNoiseLite(landformSeed++);
    this.landformWarpX.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    this.landformWarpX.SetFractalType(FastNoiseLite.FractalType.FBm);
    this.landformWarpX.SetFractalOctaves(2);
    this.landformWarpZ = new FastNoiseLite(landformSeed++);
    this.landformWarpZ.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    this.landformWarpZ.SetFractalType(FastNoiseLite.FractalType.FBm);
    this.landformWarpZ.SetFractalOctaves(2);
    this.landformBase = new FastNoiseLite(landformSeed++);
    this.landformBase.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    this.landformBase.SetFractalType(FastNoiseLite.FractalType.FBm);
    this.landformBase.SetFractalOctaves(5);   // continental shape + mid-scale relief (was 3 → too smooth)
    // Surface detail — its OWN explicit frequency (set in updateLandformConfig). Multi-octave FBm so
    // there are bumps at several scales (foothold-scale ruggedness on slopes).
    this.landformDetail = new FastNoiseLite(landformSeed++);
    this.landformDetail.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    this.landformDetail.SetFractalType(FastNoiseLite.FractalType.FBm);
    this.landformDetail.SetFractalOctaves(4);   // several octaves → fine rocks/rubble at multiple scales

    // River meander noise (seed block +80000, off the base chain) — a single low-frequency field that
    // nudges the downhill trace sideways so channels snake rather than run the straight fall line.
    this.riverMeanderNoise = new FastNoiseLite(this.config.seed + 80000);
    this.riverMeanderNoise.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    this.riverMeanderNoise.SetFractalOctaves(1);

    this.updateLandformConfig();

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
      // Merge onto the UN-scaled snapshot, then re-bake masterScale so scaling never compounds.
      this.rawCaveConfig = { ...this.rawCaveConfig, ...normalizeCaveConfig(config.caveConfig) };
      this.applyMasterScaleToCaves();
      this.updateCaveConfig();
      this.invalidateCaveCaches();   // config change invalidates traced worms/caverns
    }
    if (config.terrainLayer) {
      this.config.terrainLayer = { ...this.config.terrainLayer, ...config.terrainLayer };
      this.applyMasterScaleToCaves();   // masterScale may have changed → re-bake caves from raw
      this.updateCaveConfig();
      this.applyTerrainLayer();
      this.updateLandformConfig();
      this.invalidateCaveCaches();   // landform reshapes height → drop the per-column height/pathway memos
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

      let lfSeed = config.seed + 50000;
      this.landformWarpX.SetSeed(lfSeed++);
      this.landformWarpZ.SetSeed(lfSeed++);
      this.landformBase.SetSeed(lfSeed++);
      this.landformDetail.SetSeed(lfSeed++);

      this.riverMeanderNoise.SetSeed(config.seed + 80000);
      this.riverCellCache.clear();
      this.riverSegCache.clear();
      this.invalidateCaveCaches();   // reseed invalidates traced worms/caverns + per-column memos
    }
  }

  /** Drop all per-cell + per-chunk cave caches (after a config or seed change). */
  private invalidateCaveCaches(): void {
    this.wormCellCache.clear();
    this.chunkWormPtsFor = -1;
    this.cavernCellCache.clear();
    this.chunkCavernFeatsFor = -1;
    this.cavernWarpLat = null;
    this.breachColsCache.clear();
    // Per-column memos also depend on config/seed (height layers, warp, stamp/pathway/breach config).
    this.heightCache.clear();
    this.heightCacheEntries = 0;
    this.slopeCache.clear();
    this.slopeCacheEntries = 0;
    this.detailSlopeCache.clear();
    this.detailSlopeCacheEntries = 0;
    this.pathwayCache.clear();
    this.pathwayCacheEntries = 0;
    this.placementCache.clear();
  }

  /**
   * Fold the friendly Terrain-layer tunables onto the underlying pathway + stamp configs, which is
   * where the generator actually reads them. At the defaults this reproduces the built-in pathway /
   * building settings exactly (so a default world is unchanged). Called before the pathway/stamp
   * systems are (re)built.
   */
  private applyTerrainLayer(): void {
    const t = this.config.terrainLayer;
    const m = t.masterScale > 0 ? t.masterScale : 1;   // world scale: bigger = sparser/larger, so ×m spacing
    const p = this.rawPathwayConfig;                    // un-scaled source (idempotent baking)
    this.config.pathwayConfig = {
      ...p,
      frequency: (1 / Math.max(1, t.pathSpacing)) / m,  // cell size in meters ≈ 1/frequency; ×m via ÷m freq
      pathWidth: t.pathWidth * m,
      warpAmplitude: t.pathWarpAmplitude * m,
      warpFrequency: t.pathWarpFrequency / m,
      // Vertical / width path furniture also scales with the world so walls/dips/borders shrink with it.
      wallHeight: p.wallHeight * m,
      dipDepth: p.dipDepth * m,
      borderWidth: p.borderWidth * m,
    };
    // Scale building distributions by buildingSpacing, and ALL distributions by masterScale so
    // density-per-area holds as the world stretches. At masterScale = 1 + default buildingSpacing the
    // result is byte-identical to DEFAULT_STAMP_DISTRIBUTION.
    const distributions = DEFAULT_STAMP_DISTRIBUTION.distributions.map((d) => {
      let out = d;
      if (d.type === StampType.BUILDING_SMALL)
        out = { ...d, gridSize: t.buildingSpacing, exclusionRadius: t.buildingSpacing * 0.4 };
      else if (d.type === StampType.BUILDING_HUT)
        out = { ...d, gridSize: t.buildingSpacing * 0.6, exclusionRadius: t.buildingSpacing * 0.3 };
      else if (d.type === StampType.BUILDING_TOWER)
        out = { ...d, gridSize: t.buildingSpacing * 1.4, exclusionRadius: t.buildingSpacing * 0.5 };
      if (m !== 1) out = { ...out, gridSize: out.gridSize * m, exclusionRadius: out.exclusionRadius * m };
      return out;
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

  /** World scale (masterScale), clamped > 0. Caves scale with this alone (not landScale). */
  private get masterScale(): number {
    const m = this.config.terrainLayer.masterScale;
    return m > 0 ? m : 1;
  }

  /** Cave SIZE scale: masterScale clamped to a floor. Cave spawn-cell SPACING is deliberately NOT
   *  scaled — shrinking cell size would multiply the 3D spawn-cell count by ~1/m³ and exhaust memory
   *  (re-tracing thousands of cells per chunk). So caves get smaller with the world but keep roughly
   *  constant spacing, and the floor keeps them above voxel resolution (a 0.1× worm would be sub-voxel). */
  private get caveSizeScale(): number {
    return Math.max(this.masterScale, 0.4);
  }

  /** Combined world+land size divisor: bigger master/land scale → lower frequency → larger features. */
  private landSizeScale(): number {
    const t = this.config.terrainLayer;
    const m = t.masterScale > 0 ? t.masterScale : 1;
    const l = t.landScale > 0 ? t.landScale : 1;
    return m * l;
  }

  /** Landform noise frequencies derive from the land base frequency and the master/land scale (size
   *  divisor). The amplitude/curve knobs live in config and are read per-sample. Also (re)compiles the
   *  elevation curve from config.landformCurve. */
  private updateLandformConfig(): void {
    const t = this.config.terrainLayer;
    const sizeDiv = this.landSizeScale();
    // Higher landformScale still = more compact land (kept from before); master/land scale enlarge.
    const baseFreq = LANDFORM_BASE_FREQ * (t.landformScale > 0 ? t.landformScale : 1) / sizeDiv;
    const warpFreq = baseFreq * (t.landformWarpScale > 0 ? t.landformWarpScale : 1);
    this.landformBase.SetFrequency(baseFreq);
    this.landformWarpX.SetFrequency(warpFreq);
    this.landformWarpZ.SetFrequency(warpFreq);
    // Detail frequency is an ABSOLUTE rubble scale (not tied to the tiny continental frequency), so it
    // reads as rocks/rubble. Divided by the world size so it stays proportional — but the divisor is
    // FLOORED at 1 so shrinking the world (masterScale < 1) can't push the detail wavelength below its
    // scale-1 value (~3 m). Without this floor, at 0.1 the wavelength drops to ~0.3 m (sub-voxel), the
    // surface aliases to noise, and the post-detail slope reads vertical everywhere → rock everywhere
    // (the "green contour lines", missing beach/snow).
    const detailDiv = Math.max(sizeDiv, 1);
    this.landformDetail.SetFrequency(LANDFORM_DETAIL_BASE_FREQ * (t.landformDetailFrequency > 0 ? t.landformDetailFrequency : 1) / detailDiv);
    const pts = t.landformCurve && t.landformCurve.length >= 2 ? t.landformCurve : DEFAULT_LANDFORM_CURVE;
    this.landformCurveFn = new Curve(pts);
    this.computeSeaRemap();
    this.updateRiverConfig();
  }

  /** Sea coverage: sample the continental noise distribution once and remap the elevation-curve input so
   *  exactly `seaCoveragePercent` of columns fall below sea, regardless of the curve shape or world scale.
   *  Sets seaUThreshold (the noise percentile, in curve-input space) and seaU0 (the curve's sea crossing);
   *  elevationCurve() stretches its input so uThreshold → u0. */
  private computeSeaRemap(): void {
    const t = this.config.terrainLayer;
    // Curve sea-crossing u0 (monotone offset: negative below sea, positive above) via bisection.
    let lo = 0, hi = 1;
    if (this.landformCurveFn.eval(0) >= 0) { this.seaU0 = 0; }
    else if (this.landformCurveFn.eval(1) <= 0) { this.seaU0 = 1; }
    else { for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2; if (this.landformCurveFn.eval(mid) < 0) lo = mid; else hi = mid; } this.seaU0 = (lo + hi) / 2; }
    // Percentile threshold of the base noise over a fixed grid (deterministic, one-time ~2.3k evals).
    const cov = Math.min(0.95, Math.max(0, (t.seaCoveragePercent ?? 45) / 100));
    const N = 48, span = 4000, vals: number[] = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      vals.push(this.landformBase.GetNoise((i / (N - 1) - 0.5) * span, (j / (N - 1) - 0.5) * span));
    }
    vals.sort((a, b) => a - b);
    const noiseThresh = vals[Math.min(vals.length - 1, Math.floor(cov * vals.length))];
    this.seaUThreshold = (noiseThresh + 1) * 0.5;   // noise [-1,1] → curve input [0,1]
  }

  /** River meander frequency (scales with the world) + drop the traced-river caches (config changed). */
  private updateRiverConfig(): void {
    const sizeDiv = this.landSizeScale();
    // ~1 meander wavelength per ~200 m of land at scale 1 → gentle snaking; scales with the world.
    this.riverMeanderNoise.SetFrequency(0.005 / sizeDiv);
    this.riverCellCache.clear();
    this.riverSegCache.clear();
  }

  /** Bake the cave SIZE scale into config.caveConfig from the un-scaled rawCaveConfig: size fields
   *  ×scale, frequencies ÷scale, so caves shrink with the world. Cell SIZE (wormCellSize /
   *  cavernCellSize) is deliberately NOT scaled — shrinking it multiplies the 3D spawn-cell count by
   *  ~1/scale³ and exhausts memory. Identity at masterScale = 1; always derives from rawCaveConfig so
   *  repeated config changes never compound. */
  private applyMasterScaleToCaves(): void {
    const s = this.caveSizeScale;
    const raw = this.rawCaveConfig;
    if (this.masterScale === 1) { this.config.caveConfig = { ...raw }; return; }
    this.config.caveConfig = {
      ...raw,
      // wormCellSize / cavernCellSize intentionally left at raw (constant spacing → no count blow-up).
      wormRadius: raw.wormRadius * s,
      wormStep: raw.wormStep * s,
      wormWallAmp: raw.wormWallAmp * s,
      wormSteerFrequency: raw.wormSteerFrequency / s,
      wormWallFrequency: raw.wormWallFrequency / s,
      cavernRadius: raw.cavernRadius * s,
      cavernWinding: raw.cavernWinding * s,
      cavernWallAmp: raw.cavernWallAmp * s,
      cavernWarpFrequency: raw.cavernWarpFrequency / s,
      cavernWallFrequency: raw.cavernWallFrequency / s,
    };
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
  caveFillAt(worldX: number, worldYmeters: number, worldZ: number, surfaceMeters: number, cavernPossible = true): 0 | 1 | 2 {
    const cave = this.config.caveConfig;
    if (cave.floorY !== undefined && worldYmeters < cave.floorY) return 0;
    if (cave.wormsEnabled && this.isInsideWormCave(worldX, worldYmeters, worldZ)) return 1;
    if (cave.cavernsEnabled && cavernPossible) {
      const c = this.sampleCavern(worldX, worldYmeters, worldZ, surfaceMeters);
      if (c !== 0) return c;
    }
    return 0;
  }

  /**
   * Per-column early-out for cavern sampling (Change #3): true if ANY prepared cavern's inflated
   * horizontal reach covers this column. When false, no voxel in the column can be inside a cavern
   * (the boundary + warp + wall slop is all included), so the whole Y-column skips the cavern scan —
   * byte-identical, since it only skips columns the per-voxel proximity reject would reject at every y.
   */
  private columnHasCavern(worldX: number, worldZ: number, feats: Float64Array = this.chunkCavernFeats): boolean {
    if (feats.length === 0) return false;
    const cave = this.config.caveConfig;
    const vert = cave.cavernVerticality;
    const windAmp = cave.cavernWinding > 0 ? cave.cavernWinding : 0;
    const wallAmpAbs = cave.cavernWallAmp > 0 ? cave.cavernWallAmp : 0;
    for (let i = 0; i < feats.length; i += 4) {
      const fcx = feats[i], fcz = feats[i + 2], rx = feats[i + 3];
      const ry = rx * (1 + vert), rz = rx;
      const warpNd = windAmp > 0 ? windAmp * Math.sqrt(1 / (rx * rx) + 1 / (ry * ry) + 1 / (rz * rz)) : 0;
      const reach = rx + wallAmpAbs + rx * warpNd;   // matches the per-voxel reject at taper = 1
      const dx = worldX - fcx, dz = worldZ - fcz;
      if (dx * dx + dz * dz < reach * reach) return true;
    }
    return false;
  }

  /**
   * Mode B predicate — inside a traced worm tube? Tests the sphere centers prepared for the current
   * chunk (a flat [x,y,z,r,…] list built by prepareChunkWorms). Linear scan with a squared-distance
   * early-out; the list is small (only worms crossing this chunk) and empty for chunks with no worms.
   */
  private isInsideWormCave(x: number, y: number, z: number, pts: Float64Array = this.chunkWormPts): boolean {
    if (pts.length === 0) return false;
    const cave = this.config.caveConfig;
    // Max effective radius: the stored radius plus the largest the (signed) wall displacement can be.
    // A voxel farther than this from a tube centre can't be inside it whatever the wall value, so we
    // can skip the expensive wall noise unless the voxel is within reach of SOME tube. This is a pure
    // cost optimisation — the accept test below is unchanged, so output is byte-identical.
    const wallAmp = cave.wormWallAmp > 0 ? cave.wormWallAmp : 0;
    let wall = 0;
    let wallComputed = wallAmp === 0; // no wall noise to compute when amp is 0
    for (let i = 0; i < pts.length; i += 4) {
      const dx = x - pts[i];
      const dy = y - pts[i + 1];
      const dz = z - pts[i + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      const rMax = pts[i + 3] + wallAmp;
      if (d2 >= rMax * rMax) continue; // provably outside this tube's widest possible wall
      // Within reach — compute the real signed wall displacement once, lazily.
      if (!wallComputed) { wall = this.caveWormWall.GetNoise(x, y, z) * cave.wormWallAmp; wallComputed = true; }
      // Floor the effective radius so negative wall-roughness can't pinch a tube below the sphere
      // spacing and disconnect it. The floor ≤ WORM_MIN_RADIUS ≤ stored radius, so it never reaches
      // past the gather cull → still seamless.
      let reff = pts[i + 3] + wall;
      const carveMin = WORM_CARVE_MIN * this.caveSizeScale;   // floor scales with the (clamped) cave size
      if (reff < carveMin) reff = carveMin;
      if (d2 < reff * reff) return true;
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
  /** Pack 3 signed cell indices into one safe-integer Map key (no string build). Assumes each index
   *  fits in ±2^16 cells (± ~2,600 km at 40 m cells) — vastly beyond any real world; the packed value
   *  stays < 2^53. Avoids the per-cell string concatenation that dominated the worm gather. */
  private static cellKey(ci: number, cj: number, ck: number): number {
    return ((ci + 0x10000) * 0x20000 + (cj + 0x10000)) * 0x20000 + (ck + 0x10000);
  }
  /** 2-index packed key (same ±2^16 range assumption as cellKey). */
  private static cellKey2(a: number, b: number): number {
    return (a + 0x10000) * 0x20000 + (b + 0x10000);
  }

  private traceWormCell(ci: number, cj: number, ck: number): { pts: Float64Array; bbox: Float64Array } {
    const cacheKey = TerrainGenerator.cellKey(ci, cj, ck);
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

    // Trace straight into a right-sized Float64Array: each of the n worms emits exactly wormSegments+1
    // points × 4 floats. Avoids the ~900k-push/grow/GC churn a number[] incurs across a cold column.
    const pts = new Float64Array(n * (cave.wormSegments + 1) * 4);
    let p = 0;
    // Accumulate the sphere-cloud AABB inline as points are emitted (inflated per sphere by
    // radius+wallSlop) instead of a second pass over pts — gatherWormPts uses it to skip whole cells.
    const wallSlop = cave.wormWallAmp > 0 ? cave.wormWallAmp : 0;
    let bminX = Infinity, bminY = Infinity, bminZ = Infinity, bmaxX = -Infinity, bmaxY = -Infinity, bmaxZ = -Infinity;
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

      const fastSteer = cave.wormTurnRate === 1;
      const step = cave.wormStep;
      const K = WORM_TRACE_SUBSAMPLE;

      if (fastSteer) {
        // Fast path (default turnRate = 1): the three low-frequency steering/radius noises are the bulk
        // of the worm cold-start, so sample them only every K steps and INTERPOLATE the heading between
        // samples. We ease the advance *direction vector* linearly from the segment-start heading to the
        // freshly-sampled target across the K-step window — worms curve smoothly instead of kinking, so
        // K can be large (few noise reads) without the tunnels going faceted. Trig (cos/sin) is computed
        // only at the sample points; the per-step work is a vector lerp + one normalise.
        let dx = Math.cos(yaw), dy = 0, dz = Math.sin(yaw);   // current unit heading
        let sdx = dx, sdy = dy, sdz = dz;                     // segment-start heading
        let tdx = dx, tdy = dy, tdz = dz;                     // segment-target heading
        let radiusN = 0;
        const K2 = K * 2;   // radius bulges are large-scale → sample the radius noise half as often as steering
        for (let s = 0; s <= cave.wormSegments; s++) {
          const local = s % K;
          if (s % K2 === 0) radiusN = this.caveWormRadius.GetNoise(hx, hy, hz);
          if (local === 0) {
            sdx = dx; sdy = dy; sdz = dz;                     // curve begins from the current heading
            const yawN = this.caveWormSteerYaw.GetNoise(hx + phase, hy, hz + phase);
            const pitchN = this.caveWormSteerPitch.GetNoise(hx + phase, hy, hz + phase);
            const targetYaw = yawN * Math.PI;
            let targetPitch = pitchN * cave.wormPitchRange - cave.wormDownwardDrift;
            if (targetPitch > cave.wormMaxPitch) targetPitch = cave.wormMaxPitch;
            else if (targetPitch < -cave.wormMaxPitch) targetPitch = -cave.wormMaxPitch;
            const cp = Math.cos(targetPitch);
            tdx = Math.cos(targetYaw) * cp; tdy = Math.sin(targetPitch); tdz = Math.sin(targetYaw) * cp;
          }
          const radius = Math.max(WORM_MIN_RADIUS * this.caveSizeScale, baseR * (1 + cave.wormRadiusAlongVar * radiusN));
          pts[p++] = hx; pts[p++] = hy; pts[p++] = hz; pts[p++] = radius;
          const rr = radius + wallSlop;
          if (hx - rr < bminX) bminX = hx - rr; if (hx + rr > bmaxX) bmaxX = hx + rr;
          if (hy - rr < bminY) bminY = hy - rr; if (hy + rr > bmaxY) bmaxY = hy + rr;
          if (hz - rr < bminZ) bminZ = hz - rr; if (hz + rr > bmaxZ) bmaxZ = hz + rr;

          // Ease from segment-start heading toward the sampled target across the window, then advance.
          const f = (local + 1) / K;
          let ix = sdx + (tdx - sdx) * f, iy = sdy + (tdy - sdy) * f, iz = sdz + (tdz - sdz) * f;
          const h = Math.sqrt(ix * ix + iy * iy + iz * iz) || 1;
          dx = ix / h; dy = iy / h; dz = iz / h;
          hx += dx * step; hy += dy * step; hz += dz * step;
        }
      } else {
        // General path (turnRate ≠ 1): exact per-step ease toward the held target. Noise is still
        // sampled only every K steps (sample-and-hold), but the heading eases in each step.
        let radiusN = 0, yawN = 0, pitchN = 0;
        for (let s = 0; s <= cave.wormSegments; s++) {
          if (s % K === 0) {
            radiusN = this.caveWormRadius.GetNoise(hx, hy, hz);
            yawN = this.caveWormSteerYaw.GetNoise(hx + phase, hy, hz + phase);
            pitchN = this.caveWormSteerPitch.GetNoise(hx + phase, hy, hz + phase);
          }
          const radius = Math.max(WORM_MIN_RADIUS * this.caveSizeScale, baseR * (1 + cave.wormRadiusAlongVar * radiusN));
          pts[p++] = hx; pts[p++] = hy; pts[p++] = hz; pts[p++] = radius;
          const rr = radius + wallSlop;
          if (hx - rr < bminX) bminX = hx - rr; if (hx + rr > bmaxX) bmaxX = hx + rr;
          if (hy - rr < bminY) bminY = hy - rr; if (hy + rr > bmaxY) bmaxY = hy + rr;
          if (hz - rr < bminZ) bminZ = hz - rr; if (hz + rr > bmaxZ) bmaxZ = hz + rr;

          const targetYaw = yawN * Math.PI;
          let dYaw = targetYaw - yaw;
          dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));   // wrap to [-π, π]
          yaw += dYaw * cave.wormTurnRate;

          let targetPitch = pitchN * cave.wormPitchRange - cave.wormDownwardDrift;
          if (targetPitch > cave.wormMaxPitch) targetPitch = cave.wormMaxPitch;
          else if (targetPitch < -cave.wormMaxPitch) targetPitch = -cave.wormMaxPitch;
          pitch += (targetPitch - pitch) * cave.wormTurnRate;

          const cp = Math.cos(pitch);
          hx += Math.cos(yaw) * cp * step;
          hy += Math.sin(pitch) * step;
          hz += Math.sin(yaw) * cp * step;
        }
      }
    }

    // Sphere-cloud AABB accumulated during the trace above (Inf/-Inf when the cell has no worms → the
    // gather's box test always skips it, which is correct). gatherWormPts uses it to skip whole cells.
    const bbox = new Float64Array(6);
    bbox[0] = bminX; bbox[1] = bminY; bbox[2] = bminZ; bbox[3] = bmaxX; bbox[4] = bmaxY; bbox[5] = bmaxZ;

    if (this.wormCellCache.size > 4096) this.wormCellCache.clear();  // simple bounded cache
    const entry = { pts, bbox };
    this.wormCellCache.set(cacheKey, entry);
    return entry;
  }

  /**
   * Build the worm sphere-set relevant to a chunk. Gathers every spawn-cell within a worm's maximum
   * reach (wormSegments × wormStep + radius) of the chunk — a hard bound, since each trace step
   * advances a fixed distance — so no worm that could carve into the chunk is missed. This is what
   * makes carving seamless: adjacent chunks gather overlapping cells and trace the same worms.
   */
  private prepareChunkWorms(cx: number, cy: number, cz: number): void {
    const key = TerrainGenerator.cellKey(cx, cy, cz);
    if (this.chunkWormPtsFor === key) return;
    this.chunkWormPts = this.gatherWormPts(cx, cy, cz);
    this.chunkWormPtsFor = key;
  }

  /** Gather the worm sphere-set overlapping a chunk (see prepareChunkWorms) and return it without
   *  touching the per-chunk carve state — usable for point queries (e.g. breach detection). */
  private gatherWormPts(cx: number, cy: number, cz: number): Float64Array {
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
          const cell = this.traceWormCell(ci, cj, ck);
          // Cheap broad-phase: skip the whole cell's sphere list if its (radius+wallSlop-inflated)
          // AABB can't reach this chunk. Most gathered cells' worms wander away from a given chunk, so
          // this replaces ~one-per-sphere tests with one-per-cell. Conservative → byte-identical.
          const bb = cell.bbox;
          if (bb[3] < x0 || bb[0] > x1 || bb[4] < y0 || bb[1] > y1 || bb[5] < z0 || bb[2] > z1) continue;
          const pts = cell.pts;
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
    return new Float64Array(out);
  }

  // ---- Caverns: large tall chambers on a spacing grid (warped ellipsoids) ----

  /**
   * Deterministically spawn every cavern for one 3D spawn-cell (ci,cj,ck) as a flat
   * [centerX, centerY, centerZ, horizRadius, …] Float64Array in world meters. Pure function of
   * (ci,cj,ck,seed) — every chunk that gathers this cell reproduces identical caverns → seamless.
   * Cached per cell. (ci→X, cj→Z, ck→Y, matching the worm grid.)
   */
  private traceCavernCell(ci: number, cj: number, ck: number): Float64Array {
    const cacheKey = TerrainGenerator.cellKey(ci, cj, ck);
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
    const key = TerrainGenerator.cellKey(cx, cy, cz);
    if (this.chunkCavernFeatsFor === key) return;
    this.chunkCavernFeats = this.gatherCavernFeats(cx, cy, cz);
    this.chunkCavernFeatsFor = key;

    // Precompute the cavern domain-warp lattice for this chunk (3 components — the winding warp
    // offsets). The warp is genuinely low frequency (~33 m period), so a coarse lattice + trilerp
    // reproduces it for a fraction of the 3-GetNoise-per-voxel cost. The wall roughness is NOT
    // lattice'd — it's a 2-octave (~1.7 m) noise whose fine detail a coarse lattice would smear into
    // smooth walls — so it stays per-voxel, computed only in the boundary shell (see sampleCavern).
    const cave = this.config.caveConfig;
    if (cave.cavernWinding > 0 && this.chunkCavernFeats.length > 0) {
      const N = CAVERN_WARP_LATTICE_N;
      const chunkMeters = CHUNK_SIZE * VOXEL_SCALE;      // 8 m
      const step = chunkMeters / (N - 1);
      const ox = cx * chunkMeters, oy = cy * chunkMeters, oz = cz * chunkMeters;
      let lat = this.cavernWarpLat;
      if (!lat || lat.length !== N * N * N * 3) lat = new Float64Array(N * N * N * 3);
      let p = 0;
      for (let k = 0; k < N; k++) {
        const wz = oz + k * step;
        for (let j = 0; j < N; j++) {
          const wy = oy + j * step;
          for (let i = 0; i < N; i++) {
            const wx = ox + i * step;
            lat[p++] = this.caveCavernWarpX.GetNoise(wx, wy, wz);
            lat[p++] = this.caveCavernWarpY.GetNoise(wx, wy, wz);
            lat[p++] = this.caveCavernWarpZ.GetNoise(wx, wy, wz);
          }
        }
      }
      this.cavernWarpLat = lat;
      this.cavernWarpOx = ox; this.cavernWarpOy = oy; this.cavernWarpOz = oz;
    } else {
      this.cavernWarpLat = null;
    }
  }

  /** Gather the cavern descriptors overlapping a chunk (see prepareChunkCaverns) and return them
   *  without touching the per-chunk carve state — usable for point queries (e.g. breach detection). */
  private gatherCavernFeats(cx: number, cy: number, cz: number): Float64Array {
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
    return new Float64Array(out);
  }

  /**
   * Cavern fill at a world voxel: 0 = solid (outside / stalagmite / stalactite), 1 = air,
   * 2 = water. Scans the prepared caverns; each is a warped ellipsoid (domain warp = winding, plus
   * per-voxel wall roughness). Inside a cavern, the bottom fills with water up to a flat level and
   * hashed conical spikes rise from the floor / hang from the ceiling. Across overlapping caverns the
   * most-open result wins (air > water > solid). Pure function of position → seamless.
   */
  private sampleCavern(x: number, y: number, z: number, surfaceMeters: number, feats: Float64Array = this.chunkCavernFeats, warp: Float64Array | null = null): 0 | 1 | 2 {
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

    // Cheap proximity pre-reject: skip the 3 winding-warp + 1 wall noise evals when this voxel is
    // provably outside EVERY cavern. The warp displaces the sample by at most `cavernWinding` per world
    // axis and the wall by `cavernWallAmp` along the radius, so inflate each feature's boundary by that
    // max and test the UN-warped point; if it's outside all inflated boundaries it's outside all real
    // ones too (triangle inequality). Byte-identical output — a pure cost cut for the common far voxel.
    const windAmp = cave.cavernWinding > 0 ? cave.cavernWinding : 0;
    const wallAmpAbs = cave.cavernWallAmp > 0 ? cave.cavernWallAmp : 0;
    {
      let near = false;
      for (let i = 0; i < feats.length; i += 4) {
        const fcx = feats[i], fcy = feats[i + 1], fcz = feats[i + 2], rx = feats[i + 3];
        const ry = rx * (1 + vert), rz = rx;
        const ndx = (x - fcx) / rx, ndy = (y - fcy) / ry, ndz = (z - fcz) / rz;
        const ndSq = ndx * ndx + ndy * ndy + ndz * ndz;
        const warpNd = windAmp > 0 ? windAmp * Math.sqrt(1 / (rx * rx) + 1 / (ry * ry) + 1 / (rz * rz)) : 0;
        const t = taper * (1 + wallAmpAbs / rx) + warpNd;   // nd < t  ⟺  ndSq < t² (both ≥ 0)
        if (ndSq < t * t) { near = true; break; }
      }
      if (!near) return 0;
    }

    // Domain warp (winding) displaces the sample point — a large, low-frequency (~33 m) field, so read
    // it from the coarse per-chunk lattice (or direct GetNoise out-of-cube). Clean ellipsoid at 0.
    let wx = x, wy = y, wz = z;
    if (warp !== null) {
      // Pre-computed additive warp offset (breach scan: computed once per column at surface Y and reused
      // across the ~1 m dy band — the winding field is ~33 m period, so it barely varies over that span).
      wx = x + warp[0]; wy = y + warp[1]; wz = z + warp[2];
    } else if (cave.cavernWinding > 0) {
      const a = cave.cavernWinding;
      const lat = this.cavernWarpLat;
      const N = CAVERN_WARP_LATTICE_N;
      const step = (CHUNK_SIZE * VOXEL_SCALE) / (N - 1);
      const lx = (x - this.cavernWarpOx) / step, ly = (y - this.cavernWarpOy) / step, lz = (z - this.cavernWarpOz) / step;
      if (lat !== null && lx >= 0 && lx <= N - 1 && ly >= 0 && ly <= N - 1 && lz >= 0 && lz <= N - 1) {
        const i0 = Math.min(N - 2, lx | 0), j0 = Math.min(N - 2, ly | 0), k0 = Math.min(N - 2, lz | 0);
        const fx = lx - i0, fy = ly - j0, fz = lz - k0, NN = N * N;
        const b = (i0 + j0 * N + k0 * NN) * 3, sX = 3, sY = N * 3, sZ = NN * 3;
        for (let c = 0; c < 3; c++) {
          const o = b + c;
          const c00 = lat[o] + (lat[o + sX] - lat[o]) * fx;
          const c10 = lat[o + sY] + (lat[o + sY + sX] - lat[o + sY]) * fx;
          const c01 = lat[o + sZ] + (lat[o + sZ + sX] - lat[o + sZ]) * fx;
          const c11 = lat[o + sZ + sY] + (lat[o + sZ + sY + sX] - lat[o + sZ + sY]) * fx;
          const c0 = c00 + (c10 - c00) * fy, c1 = c01 + (c11 - c01) * fy;
          const v = (c0 + (c1 - c0) * fz) * a;
          if (c === 0) wx += v; else if (c === 1) wy += v; else wz += v;
        }
      } else {
        wx += this.caveCavernWarpX.GetNoise(x, y, z) * a;
        wy += this.caveCavernWarpY.GetNoise(x, y, z) * a;
        wz += this.caveCavernWarpZ.GetNoise(x, y, z) * a;
      }
    }

    // Wall roughness stays a full-detail per-voxel noise (2-octave, ~1.7 m — a lattice would smooth it
    // into featureless walls), but is only evaluated in the thin boundary SHELL where it can flip the
    // in/out test. Voxels provably inside (even with the deepest inward bump) or outside (even with the
    // tallest outward bump) skip it entirely — byte-identical, since the shell bands bound |wallMeters|.
    const wr = cave.cavernWallAmp > 0 ? cave.cavernWallAmp : 0;   // |wallMeters| ≤ wr (bounded FBm)
    const WALL_MARGIN = 1.05;                                      // guard the shell bands vs FBm range
    let wallMeters = 0, wallDone = false;

    let best = -1; // priority: 2 = air, 1 = water, 0 = solid; -1 = not inside any cavern
    for (let i = 0; i < feats.length; i += 4) {
      const cx = feats[i], cy = feats[i + 1], cz = feats[i + 2], rx = feats[i + 3];
      const ry = rx * (1 + vert), rz = rx;
      const dx = wx - cx, dy = wy - cy, dz = wz - cz;
      const ndx = dx / rx, ndy = dy / ry, ndz = dz / rz;
      const ndSq = ndx * ndx + ndy * ndy + ndz * ndz;
      const invRx = 1 / rx;
      const shell = taper * (wr * invRx * WALL_MARGIN);
      const thrHi = taper + shell;
      if (ndSq >= thrHi * thrHi) continue;                // outside even with the max outward wall bump
      const thrLo = taper - shell;
      if (ndSq >= thrLo * thrLo) {                        // in the shell → need the exact per-voxel wall
        if (!wallDone) { wallMeters = wr > 0 ? this.caveCavernWall.GetNoise(x, y, z) * cave.cavernWallAmp : 0; wallDone = true; }
        const thr = taper * (1 + wallMeters * invRx);     // nd ≥ thr ⟺ ndSq ≥ thr² (both ≥ 0)
        if (ndSq >= thr * thr) continue;                  // outside the (rough, surface-tapered) boundary
      }

      // Vertical span of the ellipsoid at this column → the local floor / ceiling world-Y.
      const rh2 = ndx * ndx + ndz * ndz;
      const vspan = ry * Math.sqrt(Math.max(0, 1 - rh2));
      const floorY = cy - vspan;
      const ceilY = cy + vspan;
      // Flat water surface for this chamber (fraction of full height from the bottom).
      const waterY = (cy - ry) + cave.cavernWaterLevel * 2 * ry;

      let fill: number;
      // Spike test BEFORE water so stalagmites rising through a shallow pool read as solid rock rather
      // than being reclassified as water (which hid every floor spike at the default water level).
      if (this.cavernSpikeSolid(x, z, y, floorY, ceilY)) {
        fill = 0; // stalagmite / stalactite (solid)
      } else if (cave.cavernWaterLevel > 0 && y < waterY) {
        fill = 1; // water (priority 1)
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
   * ceiling)? A hashed 2D XZ grid places at most one conical spike per cell (a pure function of its cell
   * → seamless). `cavernSpikeAmount` gates only how MANY cells get a spike; each spike is full height so
   * a low amount still yields visible (just sparser) spikes. Because a spike's base can be wider than a
   * cell, we scan the voxel's cell AND its 8 neighbours so spikes aren't clipped at cell borders.
   */
  private cavernSpikeSolid(x: number, z: number, y: number, floorY: number, ceilY: number): boolean {
    const amount = this.config.caveConfig.cavernSpikeAmount;
    if (amount <= 0) return false;
    const m = this.caveSizeScale;               // spikes scale down with the (clamped) cave size
    const cell = CAVERN_SPIKE_CELL * m;
    const seed = (this.config.seed + 70000) >>> 0;
    const bcx = Math.floor(x / cell), bcz = Math.floor(z / cell);
    // 3×3 neighbourhood: a spike centred in an adjacent cell can still reach this voxel (baseR > cell/2).
    for (let oz = -1; oz <= 1; oz++) {
      for (let ox = -1; ox <= 1; ox++) {
        const scx = bcx + ox, scz = bcz + oz;
        // Inline makeRng LCG (no closure alloc). Each `st = …; d = …` pair is one draw. dGate first so
        // empty cells (the common case) bail after a single draw.
        let st = (hashInt2(hashInt2(scx, scz), seed)) >>> 0; if (st === 0) st = 1;
        st = (Math.imul(st, 1103515245) + 12345) >>> 0; const dGate = (st & 0x7fffffff) / 0x7fffffff;
        if (dGate > amount) continue;                 // this cell has no spike
        st = (Math.imul(st, 1103515245) + 12345) >>> 0; const dFx = (st & 0x7fffffff) / 0x7fffffff;
        st = (Math.imul(st, 1103515245) + 12345) >>> 0; const dFz = (st & 0x7fffffff) / 0x7fffffff;
        const fx = (scx + dFx) * cell, fz = (scz + dFz) * cell;
        const ddx = x - fx, ddz = z - fz;
        const distXZ = Math.sqrt(ddx * ddx + ddz * ddz);
        st = (Math.imul(st, 1103515245) + 12345) >>> 0; const dPeakH = (st & 0x7fffffff) / 0x7fffffff;
        const peakH = CAVERN_SPIKE_MAX_H * m * (0.4 + 0.6 * dPeakH);   // full height regardless of amount
        const baseR = Math.max(CAVERN_SPIKE_MIN_R * m, peakH * CAVERN_SPIKE_BASE_RATIO);
        if (distXZ >= baseR) continue;
        const coneH = peakH * (1 - distXZ / baseR);
        st = (Math.imul(st, 1103515245) + 12345) >>> 0; const dStal = (st & 0x7fffffff) / 0x7fffffff;
        const h = dStal < 0.5 ? (ceilY - y) : (y - floorY);       // stalactite hangs / stalagmite rises
        if (h >= 0 && h < coneH) return true;
      }
    }
    return false;
  }

  // ---- Surface-breach map: where caves open the surface (to suppress surface features there) ----

  /**
   * Set of columns (keyed `lx + lz*CHUNK_SIZE`) in the (cx,cz) tile where an enabled cave layer
   * carves air at the terrain surface — i.e. a breach the player can see/fall into. Used to skip
   * pathways and stamps (trees / rocks / buildings) over cave openings. Computed by gathering the
   * caves for each column's SURFACE chunk (grouped, so usually 1–2 gathers) into scratch arrays and
   * testing a thin band at the top of the terrain; cached per tile. Pure function of the tile → the
   * suppression is the same from whichever cy chunk asks, so multi-chunk stamps stay consistent.
   */
  private breachedColumns(cx: number, cz: number): Set<number> {
    const key = TerrainGenerator.cellKey2(cx, cz);
    const cached = this.breachColsCache.get(key);
    if (cached) return cached;

    const cave = this.config.caveConfig;
    const set = new Set<number>();
    // One gathered feature-set per distinct surface chunk cy in this tile (reused across columns).
    const wormByCy = new Map<number, Float64Array>();
    const cavByCy = new Map<number, Float64Array>();
    // Scratch: cavern domain-warp offset computed once per breached column and reused across dy (see below).
    const warpAmt = cave.cavernWinding > 0 ? cave.cavernWinding : 0;
    const warpScratch = warpAmt > 0 ? new Float64Array(3) : null;

    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const worldX = (cx * CHUNK_SIZE + lx) * VOXEL_SCALE;
        const worldZ = (cz * CHUNK_SIZE + lz) * VOXEL_SCALE;
        const sh = this.sampleHeight(worldX, worldZ);          // surface height in voxels
        const cyS = Math.floor(sh / CHUNK_SIZE);
        const surfaceMeters = sh * VOXEL_SCALE;

        // Per-column cavern early-out: only the tiny fraction of columns whose XZ sits under a cavern
        // can breach via a cavern, so gather the surface feats once and skip the (noise-heavy) cavern
        // surface test for every other column — the dominant remaining cavern noise cost.
        let cavFeats: Float64Array | null = null;
        let cavPossible = false;
        if (cave.cavernsEnabled) {
          cavFeats = cavByCy.get(cyS) ?? null;
          if (!cavFeats) { cavFeats = this.gatherCavernFeats(cx, cyS, cz); cavByCy.set(cyS, cavFeats); }
          cavPossible = this.columnHasCavern(worldX, worldZ, cavFeats);
        }

        // Cavern domain-warp is ~33 m period; over the ~1 m dy band it's effectively constant, so compute
        // the additive offset ONCE per column (at the surface Y) and reuse it — this is the dominant
        // remaining cavern noise cost in the breach scan (3 warp evals × 5 dy → 3 per column).
        let warp: Float64Array | null = null;
        if (cavPossible && cavFeats && warpScratch) {
          const ys = sh * VOXEL_SCALE;
          warpScratch[0] = this.caveCavernWarpX.GetNoise(worldX, ys, worldZ) * warpAmt;
          warpScratch[1] = this.caveCavernWarpY.GetNoise(worldX, ys, worldZ) * warpAmt;
          warpScratch[2] = this.caveCavernWarpZ.GetNoise(worldX, ys, worldZ) * warpAmt;
          warp = warpScratch;
        }

        let breached = false;
        // Test the top few voxels of the terrain — where a cave that reaches the surface carves air.
        for (let dy = 1; dy >= -3 && !breached; dy--) {
          const y = (sh + dy) * VOXEL_SCALE;
          if (cave.wormsEnabled) {
            let pts = wormByCy.get(cyS);
            if (!pts) { pts = this.gatherWormPts(cx, cyS, cz); wormByCy.set(cyS, pts); }
            if (this.isInsideWormCave(worldX, y, worldZ, pts)) breached = true;
          }
          if (!breached && cavPossible && cavFeats) {
            if (this.sampleCavern(worldX, y, worldZ, surfaceMeters, cavFeats, warp) === 1) breached = true;
          }
        }
        if (breached) set.add(lx + lz * CHUNK_SIZE);
      }
    }

    if (this.breachColsCache.size > 1024) this.breachColsCache.clear();  // simple bounded cache
    this.breachColsCache.set(key, set);
    return set;
  }

  /** True if the column containing (worldX, worldZ) is a cave breach. Resolves the tile that OWNS that
   *  column and consults ITS breach set, so the answer is a pure function of world position — identical
   *  from whichever chunk renders the stamp. A stamp anchored in one tile but overlapping into its
   *  neighbours is therefore suppressed (or kept) as a whole, not half-drawn across the boundary. */
  /** True where the landform layer should suppress surface features (pathways, trees, rocks): at or
   *  below the beach line — i.e. underwater or on the bare sand shelf. Cheap (cached sampleHeight). */
  private isLandformSuppressed(worldX: number, worldZ: number): boolean {
    const t = this.config.terrainLayer;
    if (!t.landformEnabled) return false;   // no waterline → nothing to suppress
    return this.sampleHeight(worldX, worldZ) <= t.landformSeaLevel + this.beachBandVox();
  }

  private isBreachColumn(worldX: number, worldZ: number): boolean {
    const cave = this.config.caveConfig;
    if (!cave.wormsEnabled && !cave.cavernsEnabled) return false;
    const vx = Math.floor(worldX / VOXEL_SCALE);
    const vz = Math.floor(worldZ / VOXEL_SCALE);
    const tcx = Math.floor(vx / CHUNK_SIZE);
    const tcz = Math.floor(vz / CHUNK_SIZE);
    const breach = this.breachedColumns(tcx, tcz);
    if (breach.size === 0) return false;
    const lx = vx - tcx * CHUNK_SIZE;
    const lz = vz - tcz * CHUNK_SIZE;
    return breach.has(lx + lz * CHUNK_SIZE);
  }

  /**
   * Get the pathway material at a world position using noise-based selection
   * @param worldX - World X coordinate in meters
   * @param worldZ - World Z coordinate in meters
   * @returns Material ID for the pathway at this position
   */
  private computeGetPathwayMaterial(worldX: number, worldZ: number): number {
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
  /** Get/create the per-column pathway memo entry (nested-map by exact world X,Z, bounded like heightCache). */
  private pathEntry(worldX: number, worldZ: number): PathwayColumnInfo {
    let inner = this.pathwayCache.get(worldX);
    if (!inner) {
      if (this.pathwayCacheEntries > 262144) { this.pathwayCache.clear(); this.pathwayCacheEntries = 0; }
      inner = new Map();
      this.pathwayCache.set(worldX, inner);
    }
    let e = inner.get(worldZ);
    if (!e) { e = {}; inner.set(worldZ, e); this.pathwayCacheEntries++; }
    return e;
  }

  // Memoizing public wrappers — pathway predicates are XZ-only, so compute each once per column and
  // reuse across every cy chunk and every caller (byte-identical; internal cross-calls hit the cache).
  isOnPathway(worldX: number, worldZ: number): boolean {
    const e = this.pathEntry(worldX, worldZ);
    if (e.onPath === undefined) e.onPath = this.computeIsOnPathway(worldX, worldZ);
    return e.onPath;
  }
  isOnPathwayWall(worldX: number, worldZ: number): boolean {
    const e = this.pathEntry(worldX, worldZ);
    if (e.onWall === undefined) e.onWall = this.computeIsOnPathwayWall(worldX, worldZ);
    return e.onWall;
  }
  isOnPathwayBorder(worldX: number, worldZ: number): boolean {
    const e = this.pathEntry(worldX, worldZ);
    if (e.onBorder === undefined) e.onBorder = this.computeIsOnPathwayBorder(worldX, worldZ);
    return e.onBorder;
  }
  getPathwayDepthFactor(worldX: number, worldZ: number): number {
    const e = this.pathEntry(worldX, worldZ);
    if (e.depth === undefined) e.depth = this.computeGetPathwayDepthFactor(worldX, worldZ);
    return e.depth;
  }
  getPathwayMaterial(worldX: number, worldZ: number): number {
    const e = this.pathEntry(worldX, worldZ);
    if (e.material === undefined) e.material = this.computeGetPathwayMaterial(worldX, worldZ);
    return e.material;
  }

  // Reused across applyPathwayWarp calls — the result is always destructured immediately by callers, so
  // one shared 2-tuple avoids allocating ~15 short-lived arrays per column (GC churn on the surface scan).
  private readonly pathWarpScratch: [number, number] = [0, 0];
  private applyPathwayWarp(worldX: number, worldZ: number): [number, number] {
    const path = this.config.pathwayConfig;
    this.pathWarpScratch[0] = worldX + this.pathwayWarpX.GetNoise(worldX, worldZ) * path.warpAmplitude;
    this.pathWarpScratch[1] = worldZ + this.pathwayWarpZ.GetNoise(worldX, worldZ) * path.warpAmplitude;
    return this.pathWarpScratch;
  }

  /** Warped cellular value AT a column — every pathway predicate (path/wall/border/depth) samples this
   *  same centre before its own offset probes, so memoise it per column (2 warp + 1 cellular saved for
   *  each predicate after the first). Byte-identical: same warp + GetNoise, just computed once. */
  private pathwayCenterCell(worldX: number, worldZ: number): number {
    const e = this.pathEntry(worldX, worldZ);
    if (e.centerCell === undefined) {
      const [wx, wz] = this.applyPathwayWarp(worldX, worldZ);
      e.centerCell = this.pathwayCellular.GetNoise(wx, wz);
    }
    return e.centerCell;
  }

  // ---- Rivers: HYDROLOGY. Sources are seeded on a hashed highland grid and traced DOWNHILL along the
  // macro heightmap gradient (+ meander) into polylines — so channels lie in valleys, merge, and reach
  // the sea. Polylines are cached per source cell + gathered per chunk; the surface carves a smoothed
  // valley within riverWidth of the nearest segment. Everything scales with the world.
  /** Maximum (mouth) half-width — used to inflate the bucket gather + size the channel. */
  private riverHalfWidth(): number {
    return (this.config.terrainLayer.riverEndWidth * this.landSizeScale()) * 0.5;
  }

  /** Trace one source cell's river polyline downhill. Empty when the cell's source isn't highland. Each
   *  point stores [x, z, h, g]: position, the macro centre-line HEIGHT there (so the water surface can be
   *  flat + level, following the centre-line downstream), and a 0→1 GROWTH factor along the trace (the
   *  river starts small at the head and widens/deepens toward the sea). Deterministic + cached per cell. */
  private traceRiverCell(gi: number, gj: number): { pts: Float32Array; bbox: Float32Array } {
    const key = TerrainGenerator.cellKey2(gi, gj);
    const cached = this.riverCellCache.get(key);
    if (cached) return cached;
    const t = this.config.terrainLayer;
    const scale = this.landSizeScale();
    const S = Math.max(1, t.riverSourceSpacing) * scale;
    const rng = makeRng((hashInt2(gi, gj) ^ ((this.config.seed + 80001) >>> 0)) >>> 0);
    const sx = (gi + 0.15 + rng() * 0.7) * S;
    const sz = (gj + 0.15 + rng() * 0.7) * S;
    const sea = t.landformSeaLevel;
    const relief = t.landformMountainHeight * scale;
    const empty = { pts: new Float32Array(0), bbox: new Float32Array([0, 0, 0, 0]) };
    const sh = this.sampleLandformMacro(sx, sz);
    // Only highland columns spawn a river head (so sources sit near valley tops).
    if (sh - sea < t.riverSourceMinElevation * relief) {
      this.riverCellCache.set(key, empty); return empty;
    }
    const stepLen = Math.max(1, 3 * scale);
    const maxSteps = Math.max(4, Math.floor((t.riverMaxLength * scale) / stepLen));
    const meander = Math.max(0, t.riverMeander);
    const raw: number[] = [sx, sz, sh];   // [x, z, centre-height] triples
    let minx = sx, minz = sz, maxx = sx, maxz = sz;
    let x = sx, z = sz, dirx = 0, dirz = 0;
    for (let k = 0; k < maxSteps; k++) {
      const e = stepLen;
      const hx = this.sampleLandformMacro(x + e, z) - this.sampleLandformMacro(x - e, z);
      const hz = this.sampleLandformMacro(x, z + e) - this.sampleLandformMacro(x, z - e);
      let gx = -hx, gz = -hz;                         // downhill = negative gradient
      const glen = Math.hypot(gx, gz);
      if (glen > 1e-6) { gx /= glen; gz /= glen; }
      else { gx = dirx || 1; gz = dirz; }             // flat: keep the last heading
      const m = this.riverMeanderNoise.GetNoise(x, z) * meander;   // lateral wander
      let ndx = gx - gz * m, ndz = gz + gx * m;        // + perpendicular offset
      ndx = ndx * 0.6 + dirx * 0.4; ndz = ndz * 0.6 + dirz * 0.4;   // inertia → snake, not zig-zag
      const nl = Math.hypot(ndx, ndz) || 1; ndx /= nl; ndz /= nl;
      dirx = ndx; dirz = ndz;
      x += ndx * stepLen; z += ndz * stepLen;
      const hc = this.sampleLandformMacro(x, z);
      raw.push(x, z, hc);
      if (x < minx) minx = x; else if (x > maxx) maxx = x;
      if (z < minz) minz = z; else if (z > maxz) maxz = z;
      if (hc <= sea) break;   // reached the coast
    }
    // Pack to [x, z, h, growth]; growth = fraction along the trace (0 at head → 1 at the mouth).
    const n = raw.length / 3;
    const pts = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      pts[i * 4] = raw[i * 3]; pts[i * 4 + 1] = raw[i * 3 + 1]; pts[i * 4 + 2] = raw[i * 3 + 2];
      pts[i * 4 + 3] = n > 1 ? i / (n - 1) : 0;
    }
    const out = { pts, bbox: new Float32Array([minx, minz, maxx, maxz]) };
    if (this.riverCellCache.size > 8192) this.riverCellCache.clear();
    this.riverCellCache.set(key, out);
    return out;
  }

  /** Gather the river segments touching the chunk containing (x,z), inflated by the max half-width.
   *  Segments are 8 floats [x0,z0,h0,g0, x1,z1,h1,g1]. Cached per chunk key. */
  private riverSegsFor(worldX: number, worldZ: number): Float32Array {
    const CW = CHUNK_SIZE * VOXEL_SCALE;
    const cx = Math.floor(worldX / CW), cz = Math.floor(worldZ / CW);
    const key = TerrainGenerator.cellKey2(cx, cz);
    const cached = this.riverSegCache.get(key);
    if (cached) return cached;
    const t = this.config.terrainLayer;
    const scale = this.landSizeScale();
    const hw = this.riverHalfWidth();
    const ax0 = cx * CW - hw, az0 = cz * CW - hw, ax1 = (cx + 1) * CW + hw, az1 = (cz + 1) * CW + hw;
    const S = Math.max(1, t.riverSourceSpacing) * scale;
    const reach = t.riverMaxLength * scale + hw;   // a source this far away could still trace through
    const gi0 = Math.floor((ax0 - reach) / S), gi1 = Math.floor((ax1 + reach) / S);
    const gj0 = Math.floor((az0 - reach) / S), gj1 = Math.floor((az1 + reach) / S);
    const segs: number[] = [];
    for (let gi = gi0; gi <= gi1; gi++) for (let gj = gj0; gj <= gj1; gj++) {
      const r = this.traceRiverCell(gi, gj);
      if (r.pts.length < 8) continue;
      const b = r.bbox;
      if (b[2] < ax0 || b[0] > ax1 || b[3] < az0 || b[1] > az1) continue;   // whole trace misses the chunk
      const p = r.pts;
      for (let i = 0; i + 7 < p.length; i += 4) {
        const x0 = p[i], z0 = p[i + 1], x1 = p[i + 4], z1 = p[i + 5];
        if (Math.max(x0, x1) < ax0 || Math.min(x0, x1) > ax1 || Math.max(z0, z1) < az0 || Math.min(z0, z1) > az1) continue;
        segs.push(x0, z0, p[i + 2], p[i + 3], x1, z1, p[i + 6], p[i + 7]);
      }
    }
    const out = new Float32Array(segs);
    if (this.riverSegCache.size > 4096) this.riverSegCache.clear();
    this.riverSegCache.set(key, out);
    return out;
  }

  /** Nearest traced river to (x,z): distance + the centre-line height and growth at the closest point
   *  (interpolated along the segment). Null if no river is near. */
  private nearestRiver(worldX: number, worldZ: number): { dist: number; centreH: number; growth: number } | null {
    const segs = this.riverSegsFor(worldX, worldZ);
    let best = Infinity, bH = 0, bG = 0;
    for (let i = 0; i + 7 < segs.length; i += 8) {
      const x0 = segs[i], z0 = segs[i + 1], x1 = segs[i + 4], z1 = segs[i + 5];
      const dx = x1 - x0, dz = z1 - z0;
      const len2 = dx * dx + dz * dz;
      let tt = len2 > 0 ? ((worldX - x0) * dx + (worldZ - z0) * dz) / len2 : 0;
      tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
      const px = x0 + tt * dx, pz = z0 + tt * dz;
      const d2 = (worldX - px) * (worldX - px) + (worldZ - pz) * (worldZ - pz);
      if (d2 < best) {
        best = d2;
        bH = segs[i + 2] + tt * (segs[i + 6] - segs[i + 2]);   // interp centre-line height
        bG = segs[i + 3] + tt * (segs[i + 7] - segs[i + 3]);   // interp growth
      }
    }
    return best === Infinity ? null : { dist: Math.sqrt(best), centreH: bH, growth: bG };
  }

  /** Compute + memoize this column's river surface: the FLAT water level and carved bed (or off-river).
   *  Water is level across the channel (from the centre-line height, not the sloped terrain) and the bed
   *  is a smooth valley cross-section; both the width and depth grow from head (small) to mouth (large). */
  private ensureRiver(worldX: number, worldZ: number): PathwayColumnInfo {
    const e = this.pathEntry(worldX, worldZ);
    if (e.riverWater !== undefined) return e;
    const t = this.config.terrainLayer;
    if (!t.riversEnabled) { e.riverWater = -Infinity; e.riverBed = Infinity; return e; }
    const info = this.nearestRiver(worldX, worldZ);
    if (!info) { e.riverWater = -Infinity; e.riverBed = Infinity; return e; }
    const scale = this.landSizeScale();
    // Width lerps riverStartWidth (head) → riverEndWidth (mouth); depth still tapers with growth.
    const widthM = t.riverStartWidth + (t.riverEndWidth - t.riverStartWidth) * info.growth;
    const widthEff = Math.max(widthM * scale * 0.5, 0.3);
    if (info.dist >= widthEff) { e.riverWater = -Infinity; e.riverBed = Infinity; return e; }
    const rf = smoothstep(0, 1, 1 - info.dist / widthEff);   // 1 at centre → 0 at the bank (smooth)
    const fullDepth = Math.max(t.riverDepth * scale * (0.3 + 0.7 * info.growth), MIN_RIVER_DEPTH);
    e.riverWater = info.centreH - 1;                   // flat, level surface across the whole channel
    e.riverBed = e.riverWater - fullDepth * rf;        // deepest at the centre, rising to the banks
    return e;
  }

  isOnRiver(worldX: number, worldZ: number): boolean {
    return this.ensureRiver(worldX, worldZ).riverWater! > -Infinity;
  }
  /** Flat water-surface height for the column's channel (voxels); -Infinity when off-river. */
  getRiverWaterLevel(worldX: number, worldZ: number): number {
    return this.ensureRiver(worldX, worldZ).riverWater!;
  }
  /** Carved channel-bed height for the column (voxels); +Infinity when off-river. */
  getRiverBed(worldX: number, worldZ: number): number {
    return this.ensureRiver(worldX, worldZ).riverBed!;
  }

  /**
   * Check if a world position is on a pathway
   * Uses cellular noise with CellValue, applies domain warping, then detects edges
   * by comparing cell values at neighboring positions for uniform-width contiguous paths
   * @param worldX - World X coordinate in meters
   * @param worldZ - World Z coordinate in meters
   * @returns true if position is on a pathway
   */
  private computeIsOnPathway(worldX: number, worldZ: number): boolean {
    if (!this.config.pathwayConfig.enabled) {
      return false;
    }
    
    const path = this.config.pathwayConfig;
    const halfWidth = path.pathWidth * 0.5;
    
    // Apply domain warping for organic curved cells
    
    // Get cell value at center
    const centerCell = this.pathwayCenterCell(worldX, worldZ);
    
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
  private computeGetPathwayDepthFactor(worldX: number, worldZ: number): number {
    if (!this.config.pathwayConfig.enabled) {
      return 0;
    }
    
    const path = this.config.pathwayConfig;
    const halfWidth = path.pathWidth * 0.5;
    
    // Apply domain warping
    const centerCell = this.pathwayCenterCell(worldX, worldZ);
    
    const eps = 0.001;
    let minEdgeDist = halfWidth;

    // 4 cardinal directions with coarse step size (~4 samples per direction)
    const step = Math.max(0.3, halfWidth / 4);

    for (const [dx, dz] of PATH_CARDINALS) {
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
  private computeIsOnPathwayWall(worldX: number, worldZ: number): boolean {
    if (!this.config.pathwayConfig.enabled || this.config.pathwayConfig.wallHeight <= 0) {
      return false;
    }
    
    const path = this.config.pathwayConfig;
    const halfWidth = path.pathWidth * 0.5;
    const wallOffset = halfWidth + 0.5; // Just outside the path
    
    // Apply domain warping for organic curved cells
    
    // Get cell value at center
    const centerCell = this.pathwayCenterCell(worldX, worldZ);
    
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
  private computeIsOnPathwayBorder(worldX: number, worldZ: number): boolean {
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
    
    // Get cell value at center
    const centerCell = this.pathwayCenterCell(worldX, worldZ);
    
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
    // Memo: a vertical stack of chunks re-queries the same (worldX,worldZ) grid per cy. Exact-float
    // key, so off-grid callers just miss (recompute exactly) — output unchanged.
    let inner = this.heightCache.get(worldX);
    if (inner) {
      const cached = inner.get(worldZ);
      if (cached !== undefined) return cached;
    }

    let height: number;
    if (this.config.terrainLayer.landformEnabled) {
      height = this.sampleLandformHeight(worldX, worldZ);
    } else {
      // Apply domain warping for organic shapes. masterScale divides the sample coordinates (wider
      // hills) AND scales the relief height, so the buildings world shrinks uniformly (slopes
      // preserved). Identity at masterScale = 1.
      const m = this.config.terrainLayer.masterScale > 0 ? this.config.terrainLayer.masterScale : 1;
      const [warpedX, warpedZ] = this.applyDomainWarp(worldX, worldZ);
      const sx = warpedX / m, sz = warpedZ / m;
      let relief = 0;
      for (const layer of this.config.heightLayers) {
        relief += this.sampleNoiseLayer(sx, sz, layer);
      }
      height = this.config.baseHeight + relief * m;
    }

    // Bounded: clear wholesale past a generous cap (covers the active view's columns) rather than LRU.
    if (this.heightCacheEntries > 262144) { this.heightCache.clear(); this.heightCacheEntries = 0; inner = undefined; }
    if (!inner) { inner = new Map(); this.heightCache.set(worldX, inner); }
    inner.set(worldZ, height);
    this.heightCacheEntries++;

    return height;
  }

  /**
   * Landform height model (sea/beach/plains/mountains) — one continental field, strongly warped, run
   * through an elevation curve, plus elevation-modulated detail. Returns height in voxels. Called only
   * when landformEnabled; result is memoised by the sampleHeight cache above.
   */
  private sampleLandformHeight(worldX: number, worldZ: number): number {
    const t = this.config.terrainLayer;
    const macro = this.sampleLandformMacro(worldX, worldZ);
    // Surface detail: a dedicated noise (its own frequency, set in updateLandformConfig) whose amplitude
    // is driven by slope — flat ground gets a small floor of texture, steep faces get jagged ruggedness
    // (footholds to climb). Applied EVERYWHERE, including steep seabed under the sea (the slope term is
    // near-zero on flats, so beaches/plains stay gentle). Amplitude scales with the world.
    const vscale = this.landSizeScale();
    // Detail amplitude grows with the SQUARE of the (macro) slope angle normalized to 0..1 over 0..90°:
    // near-zero on most slopes, ramping quickly toward the steep amount only as the grade approaches
    // vertical. (Uses the macro gradient; the post-detail slope can't drive detail without recursion.)
    const slopeDeg = Math.atan(this.landformSlope(worldX, worldZ)) * (180 / Math.PI);
    const t01 = Math.min(1, slopeDeg / 90);
    const rugged = t01 * t01;
    // Detail amplitude is global (not per-biome for now): flat floor + steep ruggedness ramp.
    const amp = (t.landformDetailFlat + t.landformDetailSteep * rugged) * vscale;
    const h = amp <= 0 ? macro : macro + this.landformDetail.GetNoise(worldX, worldZ) * amp;
    return this.applyBeachLip(h);
  }

  /** Beach band height in voxels above sea level. Scales with the world (like the rest of the relief)
   *  but is floored at MIN_BEACH_VOXELS so the sand shelf stays visible at small master scales (at 0.1
   *  the scaled band would otherwise collapse below a single voxel and the beach would vanish). */
  private beachBandVox(): number {
    return Math.max(this.config.terrainLayer.landformBeachWidth * this.landSizeScale(), MIN_BEACH_VOXELS);
  }

  /** 1-voxel beach lip: wherever the surface sits within a voxel of the waterline, duck it to sea−1 so
   *  the flat water plane always covers the wet sand (kills z-fighting where sand ≈ sea). A fixed
   *  absolute voxel (not scaled), applied only to the visible surface — not the macro height used by
   *  slope estimation and river/path channels. */
  private applyBeachLip(h: number): number {
    const sea = this.config.terrainLayer.landformSeaLevel;
    return (h > sea - 1 && h < sea + 1) ? sea - 1 : h;
  }

  /**
   * Macro landform height (warp + curve, NO surface detail) — the smooth base used under pathways and
   * rivers so their channels aren't chopped up by the detail noise, and the basis for the slope estimate.
   */
  private sampleLandformMacro(worldX: number, worldZ: number): number {
    const t = this.config.terrainLayer;
    const wa = t.landformWarpStrength * this.landSizeScale();   // coast-sweep meters scale with the world
    const wx = worldX + this.landformWarpX.GetNoise(worldX, worldZ) * wa;
    const wz = worldZ + this.landformWarpZ.GetNoise(worldX, worldZ) * wa;
    return this.elevationCurve(this.landformBase.GetNoise(wx, wz));
  }

  /**
   * Map the continental noise n ∈ [-1,1] to an absolute height in voxels via the configurable elevation
   * curve. The curve outputs a normalized offset relative to sea level: negative offsets scale by the
   * sea depth (ocean floor), positive by the mountain height. Finally the whole relief is scaled about
   * sea level by master×land scale, so enlarging the world stretches height and width together (slopes
   * preserved). The default curve gives a soft sea→beach ramp (no waterline cliff).
   */
  private elevationCurve(n: number): number {
    const t = this.config.terrainLayer;
    const sea = t.landformSeaLevel;
    const u = (n + 1) * 0.5;                            // 0..1
    // Sea-coverage remap: stretch the input so the noise percentile (seaUThreshold) lands on the curve's
    // sea crossing (seaU0) → exactly `seaCoveragePercent` of columns below sea, curve shape preserved.
    const uT = this.seaUThreshold, u0 = this.seaU0;
    const ur = u <= uT ? (uT > 0 ? (u / uT) * u0 : u0)
                       : (uT < 1 ? u0 + ((u - uT) / (1 - uT)) * (1 - u0) : u0);
    const off = this.landformCurveFn.eval(ur);         // normalized offset (~ -1 .. +1)
    const raw = off >= 0 ? sea + off * t.landformMountainHeight : sea + off * t.landformSeaDepth;
    return sea + (raw - sea) * this.landSizeScale();   // vertical scale pivots on sea level
  }

  /** Landform surface slope as tan(angle): central difference of the MACRO height (so detail bumps
   *  don't register as cliffs). Memoized per column; used by detail, material and the stamp cull. */
  private landformSlope(worldX: number, worldZ: number): number {
    let inner = this.slopeCache.get(worldX);
    if (inner) { const c = inner.get(worldZ); if (c !== undefined) return c; }
    const step = 4;   // meters
    const hL = this.sampleLandformMacro(worldX - step, worldZ);
    const hR = this.sampleLandformMacro(worldX + step, worldZ);
    const hD = this.sampleLandformMacro(worldX, worldZ - step);
    const hU = this.sampleLandformMacro(worldX, worldZ + step);
    // heights are voxels → meters via VOXEL_SCALE; horizontal span is 2·step meters.
    const dhx = ((hR - hL) * VOXEL_SCALE) / (2 * step);
    const dhz = ((hU - hD) * VOXEL_SCALE) / (2 * step);
    const slope = Math.sqrt(dhx * dhx + dhz * dhz);
    if (this.slopeCacheEntries > 262144) { this.slopeCache.clear(); this.slopeCacheEntries = 0; inner = undefined; }
    if (!inner) { inner = new Map(); this.slopeCache.set(worldX, inner); }
    inner.set(worldZ, slope);
    this.slopeCacheEntries++;
    return slope;
  }

  /** POST-detail surface angle in degrees: central difference of the full detailed height over a short
   *  (~2 m) span, so the rubble detail registers. Drives the grass→rock material test — rock shows on
   *  the jagged detailed faces, not just the smooth macro grade. Memoized per column. */
  private landformDetailedSlopeDeg(worldX: number, worldZ: number): number {
    let inner = this.detailSlopeCache.get(worldX);
    if (inner) { const c = inner.get(worldZ); if (c !== undefined) return c; }
    const step = 2;   // meters — short span to capture the detail bumps, not just the macro grade
    const hL = this.sampleLandformHeight(worldX - step, worldZ);
    const hR = this.sampleLandformHeight(worldX + step, worldZ);
    const hD = this.sampleLandformHeight(worldX, worldZ - step);
    const hU = this.sampleLandformHeight(worldX, worldZ + step);
    const dhx = ((hR - hL) * VOXEL_SCALE) / (2 * step);
    const dhz = ((hU - hD) * VOXEL_SCALE) / (2 * step);
    const deg = Math.atan(Math.sqrt(dhx * dhx + dhz * dhz)) * (180 / Math.PI);
    if (this.detailSlopeCacheEntries > 262144) { this.detailSlopeCache.clear(); this.detailSlopeCacheEntries = 0; inner = undefined; }
    if (!inner) { inner = new Map(); this.detailSlopeCache.set(worldX, inner); }
    inner.set(worldZ, deg);
    this.detailSlopeCacheEntries++;
    return deg;
  }


  /**
   * Sample terrain surface at a world position (height + material)
   * Used for map tile generation without creating full chunks.
   * @param worldX - World X coordinate in meters
   * @param worldZ - World Z coordinate in meters
   * @returns Surface height (voxels) and material ID
   */
  sampleSurface(worldX: number, worldZ: number): { height: number; material: number } {
    const tlSurf = this.config.terrainLayer;
    const isPath = tlSurf.enabled && this.isOnPathway(worldX, worldZ);
    const isRiver = tlSurf.riversEnabled && this.isOnRiver(worldX, worldZ);
    // Reported surface height must match generateChunk: landform paths/rivers sit on the smooth macro
    // height so the load cap / map track the carved channel, not the (absent) detail bumps.
    const originalHeight = (tlSurf.landformEnabled && (isPath || isRiver))
      ? this.sampleLandformMacro(worldX, worldZ)
      : this.sampleHeight(worldX, worldZ);
    let height = originalHeight;

    // Dry pathway dip (no water).
    if (isPath && this.config.pathwayConfig.dipDepth > 0) {
      height -= this.config.pathwayConfig.dipDepth * this.getPathwayDepthFactor(worldX, worldZ);
    }
    // River bed: carved valley cross-section (flat, level water surface handled by the material below).
    if (isRiver) {
      const bed = this.getRiverBed(worldX, worldZ);
      if (bed < height) height = bed;
    }

    // Determine surface material.
    // Height stays at the dipped terrain floor — liquid/transparent fills
    // (water) sit above it but shouldn't raise the reported height, otherwise
    // getChunkRangeFromHeights may skip the chunk containing the actual solid surface.
    let material: number;
    const waterConfig = this.config.pathwayConfig;
    if (isRiver) {
      material = waterConfig.waterMaterial;   // rivers read as water on the 2D map
    } else if (isPath) {
      material = this.getPathwayMaterial(worldX, worldZ);
    } else if (tlSurf.enabled && this.isOnPathwayBorder(worldX, worldZ)) {
      material = this.config.pathwayConfig.borderMaterial;
    } else if (tlSurf.landformEnabled) {
      // Elevation-band material; submerged columns read as water on the 2D map. Reported height stays
      // the true (sea-floor) terrain so the load cap covers the floor — the water body above is
      // "content" that the surface-column scan picks up (same as stamp tops), raising the visible top.
      material = originalHeight < tlSurf.landformSeaLevel ? waterConfig.waterMaterial : this.landformSurfaceMaterial(originalHeight, worldX, worldZ);
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

  /** Surface material for the landform layer: gravel seabed → sand beach shelf → ROCK on steep faces
   *  (cliffs, even up high) → snow above the snow line → grass/plains elsewhere. Slope is the memoized
   *  macro-gradient angle so detail bumps don't flip flat ground to rock. */
  private landformSurfaceMaterial(heightVoxels: number, worldX: number, worldZ: number): number {
    const t = this.config.terrainLayer;
    const vscale = this.landSizeScale();             // heights are vertically scaled → scale the bands too
    const rel = heightVoxels - t.landformSeaLevel;   // voxels above sea level
    if (rel < 0) return mat('gravel');               // sea floor
    if (rel <= this.beachBandVox()) return mat('sand');   // beach band
    // Steep rock OVERRIDES snow: any steep face is bare rock, even up high. Snow then only shows above
    // the snow line on the remaining SHALLOW slopes (caps). Uses the POST-DETAIL slope so the detailed
    // rubble faces read as rock (the detail-wavelength floor keeps this from aliasing at small scale).
    const rockDeg = t.landformRockSlopeDeg > 0 ? t.landformRockSlopeDeg : 32;
    if (this.landformDetailedSlopeDeg(worldX, worldZ) >= rockDeg) return mat('rock');
    if (rel >= t.landformSnowLine * vscale) return mat('snow');   // shallow + high → snow
    return mat('moss2');                             // moss/grass everywhere else
  }

  /** True where the visible landform surface is walkable ground for stamps — moss/grass or snow (not
   *  sea, sand, or steep rock). Trees/rocks/buildings only scatter here. */
  private isStampSurface(worldX: number, worldZ: number): boolean {
    const m = this.landformSurfaceMaterial(this.sampleHeight(worldX, worldZ), worldX, worldZ);
    return m === mat('moss2') || m === mat('snow');
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
    const tl = this.config.terrainLayer;
    const seaLevel = tl.landformEnabled ? tl.landformSeaLevel : -Infinity;
    const anyCave = cave.wormsEnabled || cave.cavernsEnabled;
    if (cave.wormsEnabled) this.prepareChunkWorms(cx, cy, cz);
    if (cave.cavernsEnabled) this.prepareChunkCaverns(cx, cy, cz);

    // Base landscape generates when EITHER the Buildings layer (base terrain + pathways + stamps) OR the
    // Landforms layer (sea/mountains height) is on. With BOTH off, any enabled cave layer is rendered as
    // SOLID casts in otherwise-empty space (the cave-inspection view); with no caves either, empty air.
    const buildingsOn = tl.enabled;
    const riversOn = tl.riversEnabled;
    if (!buildingsOn && !tl.landformEnabled && !riversOn) {
      return anyCave
        ? this.generateCaveCastChunk(data, chunkWorldX, chunkWorldY, chunkWorldZ)
        : data;
    }

    // Columns where a cave breaches the surface — suppress pathways + stamps there so nothing is left
    // floating over (or bridging across) a cave opening. Null when no cave layer is enabled.
    const breach = anyCave ? this.breachedColumns(cx, cz) : null;

    // Whether any column in this chunk is on a pathway — a free early-out that gates the
    // (otherwise per-column) pathway-wall torch scan so empty chunks pay nothing for it.
    let chunkHasPath = false;

    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        // Calculate world position for this column
        const worldX = chunkWorldX + lx * VOXEL_SCALE;
        const worldZ = chunkWorldZ + lz * VOXEL_SCALE;

        // Pathway membership (roads only exist under the Buildings layer; a cave breach suppresses them).
        const columnBreached = breach !== null && breach.has(lx + lz * CHUNK_SIZE);
        const onPathRaw = buildingsOn && this.isOnPathway(worldX, worldZ) && !columnBreached;
        // Below the plains→beach edge, suppress path furniture so roads/walls stop at the coast.
        const furnitureSuppressed = this.isLandformSuppressed(worldX, worldZ);
        const isPathColumn = onPathRaw && !furnitureSuppressed;
        // Rivers: independent cellular water channels (own noise), NOT tied to the Buildings layer; a
        // cave breach still suppresses them. Rivers carry the water — paths are now dry roads.
        const isRiverColumn = riversOn && this.isOnRiver(worldX, worldZ) && !columnBreached;
        if (isPathColumn) chunkHasPath = true;

        // Paths and rivers sit on the smooth MACRO height (no detail) so their channels aren't chopped
        // up by the surface bumps; everything else uses the full detailed height.
        let terrainHeight = (tl.landformEnabled && (onPathRaw || isRiverColumn))
          ? this.sampleLandformMacro(worldX, worldZ)
          : this.sampleHeight(worldX, worldZ);

        // Walls + borders are Buildings-layer path furniture — force them off when buildings are off
        // (a Landforms/Rivers-only world), else the lazy wall/border scans below would still draw them.
        let isWallColumn = (!buildingsOn || columnBreached || furnitureSuppressed) ? 0 : -1; // -1 = unchecked, 0 = no, 1 = yes
        let isBorderColumn = (!buildingsOn || columnBreached || furnitureSuppressed) ? 0 : -1;

        const waterConfig = this.config.pathwayConfig;

        // Dry pathway dip (a sunken paved road — no water fill anymore; water lives in rivers).
        if (isPathColumn && waterConfig.dipDepth > 0) {
          terrainHeight -= waterConfig.dipDepth * this.getPathwayDepthFactor(worldX, worldZ);
        }
        // River channel: cut a bed into the terrain and fill it with water to just below the banks so
        // the channel carries on across the land (and merges with the sea where it reaches it).
        let riverWaterLevel = -Infinity;
        if (isRiverColumn) {
          const bed = this.getRiverBed(worldX, worldZ);       // carved valley bed (deepest at centre)
          if (bed < terrainHeight) terrainHeight = bed;
          riverWaterLevel = this.getRiverWaterLevel(worldX, worldZ);   // FLAT, level across the channel
        }

        // Water level: river channels and/or the sea (landform floods columns below sea level). The sea
        // surface sits 1 voxel ABOVE seaLevel so a full voxel of water covers the beach lip (which ducks
        // the shoreline terrain to sea-1) — otherwise the top water voxel lands exactly on the surface
        // boundary and reads as empty. seaLevel itself stays the terrain/material reference.
        const seaWaterLevel = terrainHeight < seaLevel ? seaLevel + 1 : -Infinity;
        const waterLevel = Math.max(riverWaterLevel, seaWaterLevel);

        // Air-column skip (Change #2): a voxel is fully air (weight -0.5 → packVoxel = 0 = the array
        // default) only when voxelY ≥ terrainHeight + 1. If this column's entire content top — terrain,
        // pathway wall, and any dip water — sits below the chunk's lowest voxel, every voxel here is air,
        // so skip the whole Y loop and leave the zeroed slice. Byte-identical; stamps are applied later.
        let colTop = terrainHeight;
        if (isPathColumn) colTop += this.config.pathwayConfig.wallHeight;
        if (waterLevel > colTop) colTop = waterLevel;
        if (colTop <= chunkWorldY - 1) continue;

        // Column-level cavern early-out (Change #3): compute once, reused for every voxel below.
        const columnCavern = cave.cavernsEnabled && this.columnHasCavern(worldX, worldZ);

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

            // Landform surface skin: sand/snow/gravel by elevation on the top few voxels (rock strata
            // underneath stay from getMaterialAtDepth). Short-circuits when the layer is off.
            if (tl.landformEnabled && depthFromSurface <= Math.max(1, LANDFORM_SKIN_DEPTH * this.landSizeScale())) {
              material = this.landformSurfaceMaterial(terrainHeight, worldX, worldZ);
            }

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
            const fill = this.caveFillAt(worldX, voxelY * VOXEL_SCALE, worldZ, terrainHeight * VOXEL_SCALE, columnCavern);
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

    // Apply stamps (trees, rocks, buildings). GATED ON stampsEnabled (its own toggle, split from Paths)
    // so "Paths" is just paths; stamps can scatter on a landform/biome world with paths off.
    if (tl.stampsEnabled && this.stampPointGenerator && this.stampPlacer) {
      // The scatter + pathway/breach filter is XZ-only, so memoize it per (cx,cz) — every cy in the
      // column reuses the same filtered list instead of redoing the 25-neighbour scatter + O(n²)
      // collision + per-placement pathway/breach noise. applyStamps treats the list read-only.
      const pkey = TerrainGenerator.cellKey2(cx, cz);
      let placements = this.placementCache.get(pkey);
      if (!placements) {
        const allPlacements = this.stampPointGenerator.generateForChunk(cx, cz);
        // Drop stamps (trees / rocks / buildings) on pathways + rivers and over cave breaches. On the
        // landform, they scatter ONLY on the moss/grass or snow surface (never sea, sand, or steep
        // rock) — the surface-material gate replaces the old beach/slope culls.
        placements = allPlacements.filter(p =>
          !this.isOnPathway(p.worldX, p.worldZ) && !this.isBreachColumn(p.worldX, p.worldZ)
          && !(riversOn && this.isOnRiver(p.worldX, p.worldZ))
          && (tl.landformEnabled ? this.isStampSurface(p.worldX, p.worldZ) : true));
        if (this.placementCache.size > 4096) this.placementCache.clear();
        this.placementCache.set(pkey, placements);
      }
      // Trees/rocks/buildings scale their model size with World scale so they shrink with the land.
      this.stampPlacer.applyStamps(data, cx, cy, cz, placements, this, this.masterScale);
    }

    // Torches along the cobble pathway walls. Gated on chunkHasPath (which already requires buildingsOn)
    // so the per-column scan only runs where a path actually is.
    if (buildingsOn && this.stampPlacer && chunkHasPath) {
      const torchPlacements = this.generatePathwayWallTorches(cx, cz);
      if (torchPlacements.length > 0) {
        // Torches scale their model with the world too, and are seated on the (now scaled) wall top.
        this.stampPlacer.applyStamps(data, cx, cy, cz, torchPlacements, this, this.masterScale);
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
    // Torch spacing scales with the world so they aren't sparse on a small-scale world's short walls.
    const stride = Math.max(1, Math.round(TerrainGenerator.TORCH_STRIDE * this.masterScale));
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
          yOffset: Math.round(cfg.wallHeight),   // integer voxel offset; wallHeight already world-scaled
        });
      }
    }
    return out;
  }
}
