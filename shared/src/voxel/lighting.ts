/**
 * Voxel lighting — two independent channels baked into the packed 32-bit word:
 *
 * 1. SKY light (low 5 bits): top-down sunlight column + horizontal BFS spread.
 *    Air gets full light, opaque solids stop the column, transparent/liquid pass
 *    light through. Modulates the PBR sun in the terrain shader (time-of-day).
 * 2. BLOCK light (bits 16-20): emitters only (e.g. lava), flooded by the same
 *    −1/step max-merge BFS across all 6 faces. Sun-independent — glows at night.
 *
 * Both run client-side before meshing, in-place on the resident chunk word —
 * server sends 0 in both fields. The two fields never interfere (each pass
 * clears + rewrites only its own bits).
 */

import {
  CHUNK_SIZE, LIGHT_MASK, LIGHT_MAX, LIGHT_BITS, MATERIAL_BITS, MATERIAL_MASK,
  SURFACE_PACKED_THRESHOLD, VOXELS_PER_CHUNK,
  BLOCK_LIGHT_SHIFT, BLOCK_LIGHT_MASK, BLOCK_LIGHT_CLEAR, VOXEL_STATIC_MASK,
} from './constants.js';
import { MATERIAL_TYPE_LUT, MAT_TYPE_SOLID, MATERIAL_EMISSION_LUT } from '../materials/Materials.js';

/** Stride constants for flat index = x + y*CHUNK_SIZE + z*CHUNK_SIZE² */
const Y_STRIDE = CHUNK_SIZE;
const Z_STRIDE = CHUNK_SIZE * CHUNK_SIZE;

/** Inverse light mask for clearing sky-light bits: ~0b11111 */
const LIGHT_CLEAR = ~LIGHT_MASK;

/** Positioned block-light field mask (bits 16-20), for fast "has block light?" tests. */
const BLOCK_LIGHT_FIELD = BLOCK_LIGHT_MASK << BLOCK_LIGHT_SHIFT;

const MAX = CHUNK_SIZE - 1;

// ============== Pre-computed LUTs (single-lookup light blocking + emission) ==============

/**
 * Light-blocking LUT indexed by `(voxel & VOXEL_STATIC_MASK) >> LIGHT_BITS`
 * (the 11 weight+material bits, with block-light/spare bits masked off).
 * Entry is 1 if the voxel is opaque solid (blocks light propagation), 0 otherwise.
 * Replaces isVoxelSolid() + MATERIAL_TYPE_LUT lookup in hot paths.
 * 2048 entries, fits comfortably in L1 cache.
 */
const VOXEL_BLOCKS_LIGHT = new Uint8Array(1 << (16 - LIGHT_BITS));

/**
 * Emission LUT indexed by `(voxel & VOXEL_STATIC_MASK) >> LIGHT_BITS`
 * (the 11 weight+material bits). Returns emission level (0-31) for solid emissive
 * voxels, 0 for everything else. Combines the isVoxelSolid() check +
 * MATERIAL_EMISSION_LUT lookup into one read. Seeds the block-light channel.
 */
const VOXEL_EMISSION = new Uint8Array(1 << (16 - LIGHT_BITS));

(function initLightingLUTs() {
  for (let wm = 0; wm < VOXEL_BLOCKS_LIGHT.length; wm++) {
    const weight = wm >> MATERIAL_BITS;
    const material = wm & MATERIAL_MASK;
    const isSolid = weight > SURFACE_PACKED_THRESHOLD;
    if (isSolid && MATERIAL_TYPE_LUT[material] === MAT_TYPE_SOLID) {
      VOXEL_BLOCKS_LIGHT[wm] = 1;
    }
    if (isSolid) {
      VOXEL_EMISSION[wm] = MATERIAL_EMISSION_LUT[material];
    }
  }
})();

/**
 * Face descriptors for border light injection.
 * Each entry: [ourFixedOffset, nbrFixedOffset, stride1, stride2]
 * Order: +X, -X, +Y, -Y, +Z, -Z (matches NEIGHBOR_DELTAS)
 */
const FACE_DESC = [
  [MAX,             0,               Y_STRIDE, Z_STRIDE], // +X: our x=31, nbr x=0
  [0,               MAX,             Y_STRIDE, Z_STRIDE], // -X: our x=0,  nbr x=31
  [MAX * Y_STRIDE,  0,               1,        Z_STRIDE], // +Y: our y=31, nbr y=0
  [0,               MAX * Y_STRIDE,  1,        Z_STRIDE], // -Y: our y=0,  nbr y=31
  [MAX * Z_STRIDE,  0,               1,        Y_STRIDE], // +Z: our z=31, nbr z=0
  [0,               MAX * Z_STRIDE,  1,        Y_STRIDE], // -Z: our z=0,  nbr z=31
] as const;

/**
 * Inject light from neighbor chunk boundaries into this chunk's edge voxels.
 *
 * For each loaded neighbor face, reads the neighbor's boundary voxel light,
 * decrements by 1, and writes it into our facing edge voxel if it exceeds
 * the current value. This seeds the subsequent BFS to spread light inward.
 *
 * @param data       This chunk's Uint32Array, modified in-place
 * @param neighbors  Array of 6 neighbor data arrays (+X, -X, +Y, -Y, +Z, -Z), null if not loaded
 */
export function injectBorderLight(
  data: Uint32Array,
  neighbors: (Uint32Array | null)[],
  seedTail: number = 0,
): number {
  let tail = seedTail;

  for (let face = 0; face < 6; face++) {
    const nData = neighbors[face];
    if (!nData) continue;

    const [ourBase, nbrBase, s1, s2] = FACE_DESC[face];

    for (let a = 0; a < CHUNK_SIZE; a++) {
      const aOff = a * s1;
      for (let b = 0; b < CHUNK_SIZE; b++) {
        const nbrIdx = nbrBase + aOff + b * s2;
        const nbrLight = nData[nbrIdx] & LIGHT_MASK;
        if (nbrLight <= 1) continue;

        const ourIdx = ourBase + aOff + b * s2;
        const ourVoxel = data[ourIdx];

        // Skip opaque solid voxels (single LUT lookup; mask off block/spare bits)
        if (VOXEL_BLOCKS_LIGHT[(ourVoxel & VOXEL_STATIC_MASK) >> LIGHT_BITS]) continue;

        const newLight = nbrLight - 1;
        if (newLight > (ourVoxel & LIGHT_MASK)) {
          data[ourIdx] = (ourVoxel & LIGHT_CLEAR) | newLight;
          // Collect as BFS seed — border voxels always have a darker inward neighbor
          if (newLight > 1) bfsQueue[tail++] = ourIdx;
        }
      }
    }
  }

  return tail;
}

/**
 * Propagate sunlight columns through a chunk's voxel data (in-place).
 *
 * For each (lx, lz) column, determines the incoming light level from above,
 * then scans downward: air and transparent/liquid pass light through,
 * opaque solids stop the column.
 *
 * @param data          The chunk's Uint32Array (CHUNK_SIZE³ entries), modified in-place
 * @param lightFromAbove Per-column light level entering the top of this chunk (0-31).
 *                      Flat array of CHUNK_SIZE² values indexed as [lx + lz * CHUNK_SIZE].
 *                      If null, every column starts at LIGHT_MAX.
 * @returns             Per-column light level exiting the bottom of this chunk (0-31).
 *                      Same layout as lightFromAbove. Caller uses this to propagate to chunk below.
 */
export function computeSunlightColumns(
  data: Uint32Array,
  lightFromAbove: Uint8Array | null,
): Uint8Array {
  const lightBelow = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);

  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    const zOff = lz * Z_STRIDE;
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const colIdx = lx + lz * CHUNK_SIZE;
      const colBase = lx + zOff;
      let light = lightFromAbove ? lightFromAbove[colIdx] : LIGHT_MAX;
      let lowestLitY = CHUNK_SIZE; // sentinel: no lit voxels in this column

      // Scan top (ly=31) down to bottom (ly=0)
      for (let ly = CHUNK_SIZE - 1; ly >= 0; ly--) {
        const idx = colBase + ly * Y_STRIDE;
        const voxel = data[idx];

        if (VOXEL_BLOCKS_LIGHT[(voxel & VOXEL_STATIC_MASK) >> LIGHT_BITS]) {
          // Opaque solid: stop column
          data[idx] = voxel & LIGHT_CLEAR;
          light = 0;
        } else {
          // Air / transparent / liquid: pass light through
          data[idx] = (voxel & LIGHT_CLEAR) | light;
          if (light > 0) lowestLitY = ly;
        }
      }

      lightBelow[colIdx] = light;
      litBottom[colIdx] = lowestLitY;
    }
  }

  return lightBelow;
}

/**
 * Build the lightFromAbove array for a chunk by checking the chunk directly above.
 *
 * If there is no chunk above loaded, assume full sunlight (return null).
 * When the chunk above eventually loads, it will relight this chunk with
 * the correct propagated values via ingestChunkData's neighbor relighting.
 *
 * If there IS a chunk above, scan its bottom row (ly=0) per column:
 *   light level = that voxel's light value (if non-solid), else 0.
 *
 * @param chunkAboveData  Voxel data of the chunk at (cx, cy+1, cz), or undefined
 * @returns               Uint8Array(CHUNK_SIZE²) with light levels, or null (null = all LIGHT_MAX)
 */
export function getSunlitAbove(
  chunkAboveData: Uint32Array | undefined,
): Uint8Array | null {
  // No chunk above loaded → assume full sky exposure.
  // When the chunk above loads later, it will relight this chunk correctly.
  if (!chunkAboveData) {
    return null;
  }

  // Chunk above exists — check its bottom row (ly=0) per column
  const result = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    const zOff = lz * Z_STRIDE;
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const idx = lx + zOff; // ly=0, so no Y offset
      const voxel = chunkAboveData[idx];
      // Pass through the light level from the bottom of the chunk above
      result[lx + lz * CHUNK_SIZE] = voxel & LIGHT_MASK;
    }
  }
  return result;
}

// ============== Column Frontier Seeding (B2 optimization) ==============

/**
 * Module-level per-column "lowest lit Y" buffer, written by computeSunlightColumns.
 * Value is the lowest y with light > 0 from the column pass, or CHUNK_SIZE if fully dark.
 * Used by seedColumnFrontiers to find shadow-edge frontier voxels in O(CHUNK_SIZE²)
 * instead of scanning all CHUNK_SIZE³ voxels.
 */
const litBottom = new Int32Array(CHUNK_SIZE * CHUNK_SIZE);

/** Horizontal neighbor deltas for column frontier detection: [colIndex delta, voxel delta] */
const H_COL_DELTA = [
  [1, 1],                      // +X
  [-1, -1],                    // -X
  [CHUNK_SIZE, Z_STRIDE],      // +Z
  [-CHUNK_SIZE, -Z_STRIDE],    // -Z
] as const;

/**
 * Collect BFS seeds from sunlight column shadow boundaries.
 *
 * After computeSunlightColumns fills litBottom[], this function does an O(CHUNK_SIZE²)
 * 2D scan comparing adjacent columns' lit ranges. Seeds are voxels with light that
 * have a darker horizontal neighbor — the BFS frontier.
 *
 * Two cases:
 * 1. Height difference: one column is lit deeper than its neighbor → seed the lit
 *    voxels in the range where the neighbor is dark.
 * 2. Light level difference: both columns lit at the same range but with different
 *    light values (from varying lightFromAbove) → seed one voxel at the boundary.
 */
function seedColumnFrontiers(data: Uint32Array, startTail: number): number {
  let tail = startTail;

  for (let z = 0; z < CHUNK_SIZE; z++) {
    const zOff = z * Z_STRIDE;
    for (let x = 0; x < CHUNK_SIZE; x++) {
      const colIdx = x + z * CHUNK_SIZE;
      const myBot = litBottom[colIdx];
      if (myBot >= CHUNK_SIZE) continue; // fully dark column, skip

      const colBase = x + zOff;

      for (let d = 0; d < 4; d++) {
        // Bounds check for each horizontal direction
        if (d === 0 && x >= MAX) continue;  // +X
        if (d === 1 && x <= 0) continue;    // -X
        if (d === 2 && z >= MAX) continue;   // +Z
        if (d === 3 && z <= 0) continue;     // -Z

        const nbrBot = litBottom[colIdx + H_COL_DELTA[d][0]];

        if (nbrBot > myBot) {
          // Case 1: Neighbor dark where we're lit — seed our frontier voxels.
          // BFS from each seed spreads light horizontally into the dark neighbor.
          const yMax = nbrBot - 1 < MAX ? nbrBot - 1 : MAX;
          for (let y = myBot; y <= yMax; y++) {
            bfsQueue[tail++] = colBase + y * Y_STRIDE;
          }
        } else if (nbrBot < CHUNK_SIZE) {
          // Case 2: Both lit — check light level difference at overlap boundary.
          // Different lightFromAbove values can create a gradient between adjacent
          // columns even when both have the same lit range.
          const checkY = myBot > nbrBot ? myBot : nbrBot;
          if (checkY <= MAX) {
            const yOff = checkY * Y_STRIDE;
            const myLight = data[colBase + yOff] & LIGHT_MASK;
            const nbrLight = data[colBase + H_COL_DELTA[d][1] + yOff] & LIGHT_MASK;
            if (myLight > nbrLight + 1) {
              // Seed one voxel — BFS propagates vertically through the neighbor column
              bfsQueue[tail++] = colBase + yOff;
            }
          }
        }
      }
    }
  }

  return tail;
}

// ============== BFS Light Propagation ==============

/** Flat index neighbor deltas: +X, -X, +Y, -Y, +Z, -Z */
const NEIGHBOR_DELTAS = new Int32Array([1, -1, Y_STRIDE, -Y_STRIDE, Z_STRIDE, -Z_STRIDE]);

/** Per-voxel valid neighbor mask (6 bits). Pre-computed once at module load. */
const VALID_NEIGHBORS = new Uint8Array(VOXELS_PER_CHUNK);
(function initValidNeighbors() {
  const MAX = CHUNK_SIZE - 1;
  for (let z = 0; z < CHUNK_SIZE; z++) {
    for (let y = 0; y < CHUNK_SIZE; y++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        let mask = 0x3F; // all 6 valid
        if (x === MAX) mask &= ~1;   // no +X
        if (x === 0)   mask &= ~2;   // no -X
        if (y === MAX) mask &= ~4;   // no +Y
        if (y === 0)   mask &= ~8;   // no -Y
        if (z === MAX) mask &= ~16;  // no +Z
        if (z === 0)   mask &= ~32;  // no -Z
        VALID_NEIGHBORS[x + y * Y_STRIDE + z * Z_STRIDE] = mask;
      }
    }
  }
})();

/** Pre-allocated BFS queue — reused across calls (single-threaded main thread).
 *  Sized 2× chunk volume: frontier seeding keeps seeds small, but BFS propagation
 *  can enqueue voxels multiple times (from different sources with increasing light). */
const bfsQueue = new Uint32Array(VOXELS_PER_CHUNK * 4);

/**
 * Propagate light via BFS within a single chunk (in-place).
 *
 * Seeds only *frontier* voxels — those with light > 1 that have at least one
 * valid neighbor with light < (srcLight - 1). This avoids seeding the vast
 * uniformly-lit sky interior and prevents queue overflow.
 *
 * Spreads to 6-face neighbors: each step decrements by 1.
 * Only updates a voxel if the new light > its current light.
 * Opaque solid voxels block propagation.
 *
 * Sky light only — emitters are handled by the block-light channel
 * (see computeBlockLight), not stamped into the sky field.
 *
 * @param data The chunk's Uint32Array (CHUNK_SIZE³ entries), modified in-place
 */
export function propagateLight(data: Uint32Array, preSeededTail?: number): void {
  const usePreSeeds = preSeededTail !== undefined;
  let head = 0;
  let tail = usePreSeeds ? preSeededTail : 0;

  // Seed frontier voxels — only when NOT using pre-collected seeds.
  // When pre-seeded, column frontiers + border inject seeds are already in the queue.
  if (!usePreSeeds) {
    for (let i = 0; i < VOXELS_PER_CHUNK; i++) {
      const light = data[i] & LIGHT_MASK;
      if (light <= 1) continue;

      const threshold = light - 1;
      const validDirs = VALID_NEIGHBORS[i];
      let frontier = false;
      for (let d = 0; d < 6; d++) {
        if (!(validDirs & (1 << d))) continue;
        if ((data[i + NEIGHBOR_DELTAS[d]] & LIGHT_MASK) < threshold) {
          frontier = true;
          break;
        }
      }
      if (frontier) {
        bfsQueue[tail++] = i;
      }
    }
  }

  // BFS — process queue in-place
  while (head < tail) {
    const idx = bfsQueue[head++];
    const srcLight = data[idx] & LIGHT_MASK;
    if (srcLight <= 1) continue;

    const newLight = srcLight - 1;
    const validDirs = VALID_NEIGHBORS[idx];

    for (let d = 0; d < 6; d++) {
      if (!(validDirs & (1 << d))) continue;

      const nIdx = idx + NEIGHBOR_DELTAS[d];
      const nVoxel = data[nIdx];

      // Skip opaque solid voxels (single LUT lookup; mask off block/spare bits)
      if (VOXEL_BLOCKS_LIGHT[(nVoxel & VOXEL_STATIC_MASK) >> LIGHT_BITS]) continue;

      // Only update if new light > existing
      if (newLight > (nVoxel & LIGHT_MASK)) {
        data[nIdx] = (nVoxel & LIGHT_CLEAR) | newLight;
        bfsQueue[tail++] = nIdx;
      }
    }
  }
}

/**
 * Combined lighting pipeline: column pass → frontier seed → border inject → BFS.
 *
 * This is the optimized entry point that fuses seed collection into the column and
 * border-inject passes, eliminating the O(CHUNK_SIZE³) frontier scan in propagateLight.
 * Column frontiers are found via an O(CHUNK_SIZE²) 2D shadow-height comparison.
 *
 * @param data           Chunk voxel data (modified in-place)
 * @param lightFromAbove Per-column light from chunk above (null = full sky)
 * @param neighbors      6 face-adjacent neighbor data arrays (null if not loaded)
 */
export function computeAndPropagateLight(
  data: Uint32Array,
  lightFromAbove: Uint8Array | null,
  neighbors: (Uint32Array | null)[],
): boolean {
  computeSkyLight(data, lightFromAbove, neighbors);
  // Independent emitter-driven light in the high bits. Reuses the same bfsQueue
  // sequentially — the sky BFS has fully drained it. Returns whether any block
  // light ended up present (used to gate incremental relights).
  return computeBlockLight(data, neighbors);
}

/**
 * Compute only the SKY-light channel (in-place): column pass → frontier seed →
 * border inject → BFS. Sky light is anchored by the sun column, so it is
 * order-independent across chunks and safe to recompute per chunk in any order.
 */
export function computeSkyLight(
  data: Uint32Array,
  lightFromAbove: Uint8Array | null,
  neighbors: (Uint32Array | null)[],
): void {
  computeSunlightColumns(data, lightFromAbove);
  let tail = seedColumnFrontiers(data, 0);
  tail = injectBorderLight(data, neighbors, tail);
  propagateLight(data, tail);
}

/**
 * Inject block light from neighbor chunk boundaries into this chunk's edge voxels.
 * Mirrors injectBorderLight but reads/writes the BLOCK_LIGHT field across all 6 faces
 * (block light has no directional "from above" column — borders carry it between chunks).
 *
 * @param data      This chunk's Uint32Array, modified in-place
 * @param neighbors 6 neighbor data arrays (+X, -X, +Y, -Y, +Z, -Z), null if not loaded
 * @param seedTail  Current BFS queue tail
 * @returns         Updated BFS queue tail
 */
function injectBorderBlockLight(
  data: Uint32Array,
  neighbors: (Uint32Array | null)[],
  seedTail: number,
): number {
  let tail = seedTail;

  for (let face = 0; face < 6; face++) {
    const nData = neighbors[face];
    if (!nData) continue;

    const [ourBase, nbrBase, s1, s2] = FACE_DESC[face];

    for (let a = 0; a < CHUNK_SIZE; a++) {
      const aOff = a * s1;
      for (let b = 0; b < CHUNK_SIZE; b++) {
        const nbrIdx = nbrBase + aOff + b * s2;
        const nbrLight = (nData[nbrIdx] >>> BLOCK_LIGHT_SHIFT) & BLOCK_LIGHT_MASK;
        if (nbrLight <= 1) continue;

        const ourIdx = ourBase + aOff + b * s2;
        const ourVoxel = data[ourIdx];

        // Skip opaque solid voxels (block light is blocked the same as sky light)
        if (VOXEL_BLOCKS_LIGHT[(ourVoxel & VOXEL_STATIC_MASK) >> LIGHT_BITS]) continue;

        const newLight = nbrLight - 1;
        if (newLight > ((ourVoxel >>> BLOCK_LIGHT_SHIFT) & BLOCK_LIGHT_MASK)) {
          data[ourIdx] = (ourVoxel & BLOCK_LIGHT_CLEAR) | (newLight << BLOCK_LIGHT_SHIFT);
          if (newLight > 1) bfsQueue[tail++] = ourIdx;
        }
      }
    }
  }

  return tail;
}

/** Zero the block-light field across a whole chunk (leaves sky/material/weight intact). */
export function clearBlockLight(data: Uint32Array): void {
  for (let i = 0; i < VOXELS_PER_CHUNK; i++) {
    if ((data[i] & BLOCK_LIGHT_FIELD) !== 0) data[i] &= BLOCK_LIGHT_CLEAR;
  }
}

/** True if the chunk contains any emitting voxel (block-light source). */
export function chunkHasEmitter(data: Uint32Array): boolean {
  for (let i = 0; i < VOXELS_PER_CHUNK; i++) {
    if (VOXEL_EMISSION[(data[i] & VOXEL_STATIC_MASK) >> LIGHT_BITS] > 0) return true;
  }
  return false;
}

/**
 * Propagate the block-light channel (in-place) WITHOUT clearing first — monotonic
 * (max-merge, only ever raises values). Stamps emitters, injects from loaded neighbor
 * borders, and floods −1/step (blocked by opaque solids, same as sky light).
 *
 * Because it never lowers a value, it is safe to run repeatedly to a fixed point across
 * a multi-chunk region (see VoxelWorld.relightBlockRegion): clear the whole region once,
 * then propagate until a full pass raises nothing. Removing a source therefore darkens
 * correctly (the clear does the lowering; propagate only rebuilds from live sources).
 *
 * @returns true if this pass raised any voxel's block light.
 */
export function propagateBlockLight(data: Uint32Array, neighbors: (Uint32Array | null)[]): boolean {
  let head = 0;
  let tail = 0;
  let changed = false;

  // Stamp emitters (max-merge against whatever is already there).
  for (let i = 0; i < VOXELS_PER_CHUNK; i++) {
    const voxel = data[i];
    const emission = VOXEL_EMISSION[(voxel & VOXEL_STATIC_MASK) >> LIGHT_BITS];
    if (emission > 0 && emission > ((voxel >>> BLOCK_LIGHT_SHIFT) & BLOCK_LIGHT_MASK)) {
      data[i] = (voxel & BLOCK_LIGHT_CLEAR) | (emission << BLOCK_LIGHT_SHIFT);
      bfsQueue[tail++] = i;
      changed = true;
    }
  }

  // Inject block light from loaded neighbor borders.
  const injectedTail = injectBorderBlockLight(data, neighbors, tail);
  if (injectedTail !== tail) changed = true;
  tail = injectedTail;

  // BFS — spread block light, −1 per step, max-merge, blocked by opaque solids.
  while (head < tail) {
    const idx = bfsQueue[head++];
    const srcLight = (data[idx] >>> BLOCK_LIGHT_SHIFT) & BLOCK_LIGHT_MASK;
    if (srcLight <= 1) continue;

    const newLight = srcLight - 1;
    const validDirs = VALID_NEIGHBORS[idx];

    for (let d = 0; d < 6; d++) {
      if (!(validDirs & (1 << d))) continue;

      const nIdx = idx + NEIGHBOR_DELTAS[d];
      const nVoxel = data[nIdx];

      if (VOXEL_BLOCKS_LIGHT[(nVoxel & VOXEL_STATIC_MASK) >> LIGHT_BITS]) continue;

      if (newLight > ((nVoxel >>> BLOCK_LIGHT_SHIFT) & BLOCK_LIGHT_MASK)) {
        data[nIdx] = (nVoxel & BLOCK_LIGHT_CLEAR) | (newLight << BLOCK_LIGHT_SHIFT);
        bfsQueue[tail++] = nIdx;
        changed = true;
      }
    }
  }

  return changed;
}

/**
 * Compute the block-light channel for a single chunk in isolation (clear + propagate).
 * Correct on its own; for a multi-chunk incremental update after an edit, use the
 * region-based clear-once/propagate-to-fixed-point flow instead (VoxelWorld).
 *
 * @returns true if the chunk ended up with any block light.
 */
export function computeBlockLight(data: Uint32Array, neighbors: (Uint32Array | null)[]): boolean {
  clearBlockLight(data);
  return propagateBlockLight(data, neighbors);
}
