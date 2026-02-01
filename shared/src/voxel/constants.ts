/**
 * Voxel terrain constants shared between client and server
 */

// ============== Chunk Dimensions ==============
/** Number of voxels per chunk axis */
export const CHUNK_SIZE = 32;

/** Meters per voxel */
export const VOXEL_SCALE = 0.25;

/** World size of a chunk in meters (CHUNK_SIZE * VOXEL_SCALE) */
export const CHUNK_WORLD_SIZE = CHUNK_SIZE * VOXEL_SCALE; // 8m

/** Total voxels per chunk (CHUNK_SIZE^3) */
export const VOXELS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE; // 32768

// ============== Voxel Bit Layout ==============
// Layout: WWWW MMMMMMM LLLLL (16 bits total)
//         4    7       5

/** Bits for weight field (surface distance) */
export const WEIGHT_BITS = 4;

/** Bits for material ID field */
export const MATERIAL_BITS = 7;

/** Bits for light level field */
export const LIGHT_BITS = 5;

/** Maximum weight value in packed form */
export const WEIGHT_MAX_PACKED = (1 << WEIGHT_BITS) - 1; // 15

/** Maximum material ID value */
export const MATERIAL_MAX = (1 << MATERIAL_BITS) - 1; // 127

/** Maximum light level value */
export const LIGHT_MAX = (1 << LIGHT_BITS) - 1; // 31

/** Bit shift for material field */
export const MATERIAL_SHIFT = LIGHT_BITS; // 5

/** Bit shift for weight field */
export const WEIGHT_SHIFT = LIGHT_BITS + MATERIAL_BITS; // 12

/** Bit mask for light field */
export const LIGHT_MASK = LIGHT_MAX; // 0b11111

/** Bit mask for material field (before shift) */
export const MATERIAL_MASK = MATERIAL_MAX; // 0b1111111

/** Bit mask for weight field (before shift) */
export const WEIGHT_MASK = WEIGHT_MAX_PACKED; // 0b1111

// ============== Weight Range ==============
/** Minimum weight value in world units */
export const WEIGHT_MIN = -0.5;

/** Maximum weight value in world units */
export const WEIGHT_MAX = 0.5;

/** Weight range for mapping */
export const WEIGHT_RANGE = WEIGHT_MAX - WEIGHT_MIN; // 1.0

// ============== Streaming ==============
/** Number of chunks to load in each direction from player */
export const STREAM_RADIUS = 6;

/** Extra margin (in chunks) before unloading - prevents pop-in/out at boundaries */
export const STREAM_UNLOAD_MARGIN = 1;

/** Initial terrain height in voxel units (-16 voxels = -4m surface) */
export const INITIAL_TERRAIN_HEIGHT = -16;
