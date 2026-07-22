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
// Layout (32-bit word):
//   bit:  0-4    5-11      12-15   16-20        21-31
//         LLLLL  MMMMMMM   WWWW    BBBBB        (spare, 11 bits for future)
//         sky    material  weight  block-light
//
// The low 16 bits (sky light + material + weight) are byte-identical to the
// previous 16-bit layout, so every existing pack/unpack shift & mask is unchanged.
// Block light lives at bit 16; the top 11 bits are reserved for future per-voxel data.

/** Bits for weight field (surface distance) */
export const WEIGHT_BITS = 4;

/** Bits for material ID field */
export const MATERIAL_BITS = 7;

/** Bits for (sky) light level field */
export const LIGHT_BITS = 5;

/** Bits for block-light field */
export const BLOCK_LIGHT_BITS = 5;

/** Maximum weight value in packed form */
export const WEIGHT_MAX_PACKED = (1 << WEIGHT_BITS) - 1; // 15

/** Maximum material ID value */
export const MATERIAL_MAX = (1 << MATERIAL_BITS) - 1; // 127

/** Maximum (sky) light level value */
export const LIGHT_MAX = (1 << LIGHT_BITS) - 1; // 31

/** Maximum block-light level value */
export const BLOCK_LIGHT_MAX = (1 << BLOCK_LIGHT_BITS) - 1; // 31

/** Bit shift for material field */
export const MATERIAL_SHIFT = LIGHT_BITS; // 5

/** Bit shift for weight field */
export const WEIGHT_SHIFT = LIGHT_BITS + MATERIAL_BITS; // 12

/** Bit shift for block-light field (first bit past the original 16-bit word) */
export const BLOCK_LIGHT_SHIFT = 16;

/** Bit mask for (sky) light field */
export const LIGHT_MASK = LIGHT_MAX; // 0b11111

/** Bit mask for material field (before shift) */
export const MATERIAL_MASK = MATERIAL_MAX; // 0b1111111

/** Bit mask for weight field (before shift) */
export const WEIGHT_MASK = WEIGHT_MAX_PACKED; // 0b1111

/** Bit mask for block-light field (before shift) */
export const BLOCK_LIGHT_MASK = BLOCK_LIGHT_MAX; // 0b11111

/** Clear mask for the block-light field (positioned, for read-modify-write) */
export const BLOCK_LIGHT_CLEAR = ~(BLOCK_LIGHT_MASK << BLOCK_LIGHT_SHIFT);

/**
 * Mask for the "static" low 16 bits (weight + material + sky light) of the word.
 * Used to strip block-light/spare bits before indexing the material/weight LUTs,
 * which are sized 1<<(16-LIGHT_BITS) and indexed by `word >> LIGHT_BITS`.
 */
export const VOXEL_STATIC_MASK = 0xFFFF;

/** Packed weight threshold for surface (weight=0 boundary) */
export const SURFACE_PACKED_THRESHOLD = WEIGHT_MAX_PACKED >> 1; // 7

/** Precomputed 1/WEIGHT_MAX_PACKED for fast weight unpacking */
export const INV_WEIGHT_MAX_PACKED = 1.0 / WEIGHT_MAX_PACKED; // ~0.0667

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

// ============== Collision ==============

/** Max Chebyshev chunk distance for shapecast tests against the player capsule */
export const COLLISION_CHUNK_RADIUS = 1;

/** Max Chebyshev chunk distance for maintaining BVH collider meshes around the player */
export const COLLIDER_CHUNK_RADIUS = 2;

// ============== Visibility Culling ==============
/**
 * Maximum supported view distance, in chunks, and the radius the visibility BFS pre-allocates its
 * grid buffers for (GRID_DIAMETER = 2*R+1). This MUST be >= the largest selectable view distance
 * (see QualityPresets' visibilityRadius options) — the BFS clips traversal at the grid edge, so a
 * view distance beyond this would silently fail to reach. Also the initial/fallback radius before
 * quality settings apply.
 */
export const VISIBILITY_RADIUS = 11;

/** Buffer distance beyond visible before unloading */
export const VISIBILITY_UNLOAD_BUFFER = 1;

// ============== LOD zoom (Explore) ==============
/**
 * Highest LOD zoom level in Explore. A level-L chunk samples the same world at a 2^L step and covers
 * 8·2^L m, so level MAX covers 8·2^MAX m per chunk. Bounds memory/coarseness of the zoomed-out view.
 */
export const MAX_ZOOM_LEVEL = 6;

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

// ============== Meshing ==============

/** High-side margin (in voxels) added to chunk grid for SurfaceNet stitching */
export const MESH_MARGIN = 2;

/** Grid dimension: CHUNK_SIZE + MESH_MARGIN */
export const GRID_SIZE = CHUNK_SIZE + MESH_MARGIN; // 34

// ============== Canonical Neighbor Offsets ==============

/** 6 face-adjacent neighbor offsets: +X, -X, +Y, -Y, +Z, -Z */
export const FACE_OFFSETS_6: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
] as const;

/** All 26 neighbor offsets (6 face + 12 edge + 8 corner) for margin stitching */
export const NEIGHBOR_OFFSETS_26: readonly (readonly [number, number, number])[] = [
  // 6 face neighbors
  [-1, 0, 0], [1, 0, 0],
  [0, -1, 0], [0, 1, 0],
  [0, 0, -1], [0, 0, 1],
  // 12 edge neighbors
  [-1, -1, 0], [-1, 1, 0], [1, -1, 0], [1, 1, 0],
  [-1, 0, -1], [-1, 0, 1], [1, 0, -1], [1, 0, 1],
  [0, -1, -1], [0, -1, 1], [0, 1, -1], [0, 1, 1],
  // 8 corner neighbors
  [-1, -1, -1], [-1, -1, 1], [-1, 1, -1], [-1, 1, 1],
  [1, -1, -1], [1, -1, 1], [1, 1, -1], [1, 1, 1],
] as const;

/**
 * Positive-direction face offsets (+X, +Y, +Z).
 * These are the 3 neighbors whose data appears in a chunk's high-side mesh margin.
 * Use for: "which neighbors does MY mesh depend on?" / pending-neighbor checks.
 */
export const POSITIVE_FACE_OFFSETS_3: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [0, 1, 0], [0, 0, 1],
] as const;

/**
 * Negative-direction face offsets (-X, -Y, -Z).
 * These are the 3 neighbors whose mesh margins read from MY data.
 * Use for: "which neighbors' meshes are stale when I change?"
 */
export const NEGATIVE_FACE_OFFSETS_3: readonly (readonly [number, number, number])[] = [
  [-1, 0, 0], [0, -1, 0], [0, 0, -1],
] as const;

/**
 * Negative-direction margin-consumer offsets (7): the 3 faces, 3 edges, and 1 corner of the negative
 * octant. A chunk's mesh reads its +X/+Y/+Z faces, edges, and corner as margin, so a changed chunk's
 * voxels are consumed as margin by exactly these 7 neighbours (plus itself). Their boundary GEOMETRY
 * changes when the chunk changes, so they must fully re-mesh — build preview and commit share this
 * set so their re-mesh sets can't drift. Each offset's non-zero axes are the ones whose LOW margin the
 * neighbour reads (used to test which drawn-chunk sub-region a neighbour actually consumes).
 */
export const NEGATIVE_MARGIN_OFFSETS_7: readonly (readonly [number, number, number])[] = [
  [-1, 0, 0], [0, -1, 0], [0, 0, -1],
  [-1, -1, 0], [-1, 0, -1], [0, -1, -1],
  [-1, -1, -1],
] as const;

/**
 * Positive-direction margin-source offsets (7): the 3 faces, 3 edges, and 1 corner of the POSITIVE
 * octant — exactly the neighbours a chunk's mesh reads as its high-side (+X/+Y/+Z) margin (see
 * expandChunkData). A chunk must have all 7 present to mesh its boundary without extrapolation; the
 * mirror of NEGATIVE_MARGIN_OFFSETS_7 (which are the chunks that consume THIS chunk as their margin).
 */
export const POSITIVE_MARGIN_OFFSETS_7: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [0, 1, 0], [0, 0, 1],
  [1, 1, 0], [1, 0, 1], [0, 1, 1],
  [1, 1, 1],
] as const;

/**
 * ================= CHUNK DEPENDENCY CONTRACT (read before touching streaming/meshing) =================
 *
 * A chunk's surface mesh is NOT a function of its own voxels alone — it is a function of the chunk AND
 * a fixed set of neighbours. Every subsystem that loads, meshes, invalidates, or renders chunks must
 * agree on that neighbour set, or the derived representations drift apart and holes/pops appear. These
 * offset tables are the single source of truth; the four consumers below MUST all derive from them:
 *
 *   1. READ  (mesh input)     — expandChunkData reads POSITIVE_MARGIN_OFFSETS_7 as the high-side margin.
 *   2. WAIT  (mesh readiness) — a chunk defers meshing until its POSITIVE_MARGIN_OFFSETS_7 are resolved.
 *   3. INVALIDATE (re-mesh)   — when a chunk changes, its NEGATIVE_MARGIN_OFFSETS_7 consumers re-mesh.
 *   4. LOAD/RENDER (coverage) — a chunk may only be rendered once its margin sources exist, so loading
 *                               must stay one ring AHEAD of rendering (render ⊆ load − 1 ring). The
 *                               render/load one-ring dilation uses FACE_OFFSETS_6.
 *
 * BOUNDARY OWNERSHIP: the shared face between chunk A and its +axis neighbour B is meshed ONLY by A
 * (A's high face, built from B's voxels); B skips its low face. So a boundary's surface belongs to the
 * LOWER-coordinate chunk. Consequences:
 *   - A rendered chunk needs its +margin neighbours LOADED (to build its own high faces) and its lower
 *     neighbours RENDERED (they own the surface on its low faces). Hence the load set must dilate the
 *     render set on all sides, and rendering must be gated on mesh completeness (no skipped high faces).
 *   - Meshing a chunk with an absent +neighbour SKIPS that high face (skipHighBoundary) → a hole that
 *     only heals when the neighbour streams in and the chunk re-meshes. Never render such a mesh.
 * =====================================================================================================
 */
