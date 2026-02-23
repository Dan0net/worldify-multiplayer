/**
 * Voxel lighting — sunlight column propagation + horizontal BFS spread
 *
 * Two passes, both operating on packed 16-bit voxel data in-place:
 * 1. Column pass: top-down per (x,z) column. Air gets full light, opaque stops,
 *    transparent/liquid pass light through (like air).
 * 2. BFS pass: spreads light from all lit voxels into 6-face neighbors,
 *    decrementing by 1 per step. Only updates if new > existing.
 *
 * This runs client-side before meshing — server sends light=0.
 */

import { CHUNK_SIZE, LIGHT_MASK, LIGHT_MAX, LIGHT_BITS, MATERIAL_BITS, MATERIAL_MASK, SURFACE_PACKED_THRESHOLD, VOXELS_PER_CHUNK } from './constants.js';
import { MATERIAL_TYPE_LUT, MAT_TYPE_SOLID, MATERIAL_EMISSION_LUT } from '../materials/Materials.js';

/** Stride constants for flat index = x + y*CHUNK_SIZE + z*CHUNK_SIZE² */
const Y_STRIDE = CHUNK_SIZE;
const Z_STRIDE = CHUNK_SIZE * CHUNK_SIZE;

/** Inverse light mask for clearing light bits: ~0b11111 */
const LIGHT_CLEAR = ~LIGHT_MASK;

const MAX = CHUNK_SIZE - 1;

// ============== Pre-computed LUTs (single-lookup light blocking + emission) ==============

/**
 * Light-blocking LUT indexed by voxel >> LIGHT_BITS (upper 11 bits: weight + material).
 * Entry is 1 if the voxel is opaque solid (blocks light propagation), 0 otherwise.
 * Replaces isVoxelSolid() + MATERIAL_TYPE_LUT lookup in hot paths.
 * 2048 entries, fits comfortably in L1 cache.
 */
const VOXEL_BLOCKS_LIGHT = new Uint8Array(1 << (16 - LIGHT_BITS));

/**
 * Emission LUT indexed by voxel >> LIGHT_BITS (upper 11 bits: weight + material).
 * Returns emission level (0-31) for solid emissive voxels, 0 for everything else.
 * Combines the isVoxelSolid() check + MATERIAL_EMISSION_LUT lookup into one read.
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
 * @param data       This chunk's Uint16Array, modified in-place
 * @param neighbors  Array of 6 neighbor data arrays (+X, -X, +Y, -Y, +Z, -Z), null if not loaded
 */
export function injectBorderLight(
  data: Uint16Array,
  neighbors: (Uint16Array | null)[],
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

        // Skip opaque solid voxels (single LUT lookup)
        if (VOXEL_BLOCKS_LIGHT[ourVoxel >> LIGHT_BITS]) continue;

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
 * @param data          The chunk's Uint16Array (CHUNK_SIZE³ entries), modified in-place
 * @param lightFromAbove Per-column light level entering the top of this chunk (0-31).
 *                      Flat array of CHUNK_SIZE² values indexed as [lx + lz * CHUNK_SIZE].
 *                      If null, every column starts at LIGHT_MAX.
 * @returns             Per-column light level exiting the bottom of this chunk (0-31).
 *                      Same layout as lightFromAbove. Caller uses this to propagate to chunk below.
 */
export function computeSunlightColumns(
  data: Uint16Array,
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

        if (VOXEL_BLOCKS_LIGHT[voxel >> LIGHT_BITS]) {
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
  chunkAboveData: Uint16Array | undefined,
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
function seedColumnFrontiers(data: Uint16Array, startTail: number): number {
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
 * @param data The chunk's Uint16Array (CHUNK_SIZE³ entries), modified in-place
 */
export function propagateLight(data: Uint16Array, preSeededTail?: number): void {
  const usePreSeeds = preSeededTail !== undefined;
  let head = 0;
  let tail = usePreSeeds ? preSeededTail : 0;

  // Pass 1: Stamp emitting voxels (e.g. lava) into the light field.
  // VOXEL_EMISSION LUT encodes both the solid check and emission level.
  for (let i = 0; i < VOXELS_PER_CHUNK; i++) {
    const voxel = data[i];
    const emission = VOXEL_EMISSION[voxel >> LIGHT_BITS];
    if (emission > 0 && emission > (voxel & LIGHT_MASK)) {
      data[i] = (voxel & LIGHT_CLEAR) | emission;
      // When using pre-seeded path, add emitters directly to queue
      if (usePreSeeds) bfsQueue[tail++] = i;
    }
  }

  // Pass 2: Seed frontier voxels — only when NOT using pre-collected seeds.
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

      // Skip opaque solid voxels (single LUT lookup replaces isVoxelSolid + material check)
      if (VOXEL_BLOCKS_LIGHT[nVoxel >> LIGHT_BITS]) continue;

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
  data: Uint16Array,
  lightFromAbove: Uint8Array | null,
  neighbors: (Uint16Array | null)[],
): void {
  // Step 1: Column pass — writes light top-down + fills litBottom[] for frontier detection
  computeSunlightColumns(data, lightFromAbove);

  // Step 2: Seed column frontier voxels from shadow-height differences (O(CHUNK_SIZE²))
  let tail = seedColumnFrontiers(data, 0);

  // Step 3: Border inject — seeds injected voxels directly into the queue
  tail = injectBorderLight(data, neighbors, tail);

  // Step 4: BFS from pre-collected seeds (skips the full-volume frontier scan)
  propagateLight(data, tail);
}
