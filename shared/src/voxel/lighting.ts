/**
 * Voxel lighting — sunlight column propagation + horizontal BFS spread
 *
 * Two passes, both operating on packed 16-bit voxel data in-place:
 * 1. Column pass: top-down per (x,z) column. Air gets full light, opaque stops,
 *    transparent/liquid attenuates by 1.
 * 2. BFS pass: spreads light from all lit voxels into 6-face neighbors,
 *    decrementing by 1 per step. Only updates if new > existing.
 *
 * This runs client-side before meshing — server sends light=0.
 */

import { CHUNK_SIZE, LIGHT_MASK, LIGHT_MAX, MATERIAL_SHIFT, MATERIAL_MASK, VOXELS_PER_CHUNK } from './constants.js';
import { isVoxelSolid } from './voxelData.js';
import { MATERIAL_TYPE_LUT, MAT_TYPE_SOLID, MATERIAL_EMISSION_LUT } from '../materials/Materials.js';

/** Stride constants for flat index = x + y*CHUNK_SIZE + z*CHUNK_SIZE² */
const Y_STRIDE = CHUNK_SIZE;
const Z_STRIDE = CHUNK_SIZE * CHUNK_SIZE;

/** Inverse light mask for clearing light bits: ~0b11111 */
const LIGHT_CLEAR = ~LIGHT_MASK;

const MAX = CHUNK_SIZE - 1;

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
): void {
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

        // Skip opaque solid voxels
        if (isVoxelSolid(ourVoxel)) {
          const matType = MATERIAL_TYPE_LUT[(ourVoxel >> MATERIAL_SHIFT) & MATERIAL_MASK];
          if (matType === MAT_TYPE_SOLID) continue;
        }

        const newLight = nbrLight - 1;
        if (newLight > (ourVoxel & LIGHT_MASK)) {
          data[ourIdx] = (ourVoxel & LIGHT_CLEAR) | newLight;
        }
      }
    }
  }
}

/**
 * Propagate sunlight columns through a chunk's voxel data (in-place).
 *
 * For each (lx, lz) column, determines the incoming light level from above,
 * then scans downward: air passes light through, transparent/liquid attenuate by 1,
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

      // Scan top (ly=31) down to bottom (ly=0)
      for (let ly = CHUNK_SIZE - 1; ly >= 0; ly--) {
        const idx = colBase + ly * Y_STRIDE;
        const voxel = data[idx];

        if (isVoxelSolid(voxel)) {
          const matType = MATERIAL_TYPE_LUT[(voxel >> MATERIAL_SHIFT) & MATERIAL_MASK];
          if (matType !== MAT_TYPE_SOLID) {
            // Transparent/liquid: attenuate by 1, write current light
            data[idx] = (voxel & LIGHT_CLEAR) | light;
            if (light > 0) light--;
          } else {
            // Opaque solid: stop column
            data[idx] = voxel & LIGHT_CLEAR;
            light = 0;
          }
        } else {
          // Air: full sunlight passthrough
          data[idx] = (voxel & LIGHT_CLEAR) | light;
        }
      }

      lightBelow[colIdx] = light;
    }
  }

  return lightBelow;
}

/**
 * Build the lightFromAbove array for a chunk by checking the chunk directly above.
 *
 * If there is no chunk above:
 *   - cy >= maxCy → assume full sunlight (return null, meaning all LIGHT_MAX)
 *   - cy < maxCy  → assume dark (return all-zero array)
 *
 * If there IS a chunk above, scan its bottom row (ly=0) per column:
 *   light level = that voxel's light value (if non-solid), else 0.
 *
 * @param chunkAboveData  Voxel data of the chunk at (cx, cy+1, cz), or undefined
 * @param cy              This chunk's Y coordinate
 * @param maxCy           The highest chunk Y that contains terrain in this column
 * @returns               Uint8Array(CHUNK_SIZE²) with light levels, or null (null = all LIGHT_MAX)
 */
export function getSunlitAbove(
  chunkAboveData: Uint16Array | undefined,
  cy: number,
  maxCy: number,
): Uint8Array | null {
  // No chunk above
  if (!chunkAboveData) {
    // At or above the terrain ceiling → full sky exposure
    if (cy >= maxCy) return null;
    // Below terrain ceiling but chunk not loaded → assume dark
    return new Uint8Array(CHUNK_SIZE * CHUNK_SIZE); // all zeros
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
const bfsQueue = new Uint32Array(VOXELS_PER_CHUNK * 2);

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
export function propagateLight(data: Uint16Array): void {
  let head = 0;
  let tail = 0;

  // Pass 1: Stamp emitting voxels (e.g. lava) into the light field.
  // Check isVoxelSolid: air-side voxels (weight >= 0) can retain a non-zero
  // material ID as a leftover — only actual solid/liquid bodies should emit.
  for (let i = 0; i < VOXELS_PER_CHUNK; i++) {
    const voxel = data[i];
    if (!isVoxelSolid(voxel)) continue;
    const emission = MATERIAL_EMISSION_LUT[(voxel >> MATERIAL_SHIFT) & MATERIAL_MASK];
    if (emission > 0 && emission > (voxel & LIGHT_MASK)) {
      data[i] = (voxel & LIGHT_CLEAR) | emission;
    }
  }

  // Pass 2: Seed frontier voxels (adjacent to a lower-light neighbor)
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

  // BFS — process queue in-place (no double-buffering needed:
  // each enqueued voxel carries its light in the data array)
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

      // Skip opaque solid voxels
      if (isVoxelSolid(nVoxel)) {
        const matType = MATERIAL_TYPE_LUT[(nVoxel >> MATERIAL_SHIFT) & MATERIAL_MASK];
        if (matType === MAT_TYPE_SOLID) continue;
      }

      // Only update if new light > existing
      if (newLight > (nVoxel & LIGHT_MASK)) {
        data[nIdx] = (nVoxel & LIGHT_CLEAR) | newLight;
        bfsQueue[tail++] = nIdx;
      }
    }
  }
}
