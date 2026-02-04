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
/** XZ radius for surface column requests (horizontal view distance) */
export const SURFACE_COLUMN_RADIUS = 6;

/** 3D radius for chunk requests around player (caves/digging) */
export const PLAYER_CHUNK_RADIUS = 2;

/** Extra margin (in chunks) before unloading - prevents pop-in/out at boundaries */
export const STREAM_UNLOAD_MARGIN = 1;

/** Initial terrain height in voxel units (-16 voxels = -4m surface) */
export const INITIAL_TERRAIN_HEIGHT = -16;

// ============== Visibility Culling ==============
/** Maximum BFS traversal distance in chunks */
export const VISIBILITY_RADIUS = 8;

/** Buffer distance beyond visible before unloading */
export const VISIBILITY_UNLOAD_BUFFER = 2;

/**
 * Face indices for visibility graph.
 * Used to encode which faces can see each other through a chunk.
 */
export const enum ChunkFace {
  POS_X = 0,  // +X
  NEG_X = 1,  // -X
  POS_Y = 2,  // +Y
  NEG_Y = 3,  // -Y
  POS_Z = 4,  // +Z
  NEG_Z = 5,  // -Z
}

/** Number of chunk faces */
export const CHUNK_FACE_COUNT = 6;

/** Number of face pairs for visibility (C(6,2) = 15) */
export const VISIBILITY_PAIR_COUNT = 15;

/** All face pairs visible (empty chunk) */
export const VISIBILITY_ALL = 0x7FFF;

/** No face pairs visible (solid chunk) */
export const VISIBILITY_NONE = 0x0000;
