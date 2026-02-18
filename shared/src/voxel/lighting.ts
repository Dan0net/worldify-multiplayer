/**
 * Voxel lighting — sunlight column propagation
 *
 * Scans each (x,z) column top-down. Sky-exposed non-solid voxels get full sunlight.
 * Opaque solid voxels stop the column. Transparent/liquid solids attenuate by 1.
 * Light is written directly into the packed 16-bit data using bit ops
 * (light occupies the bottom 5 bits).
 *
 * This runs client-side before meshing — server sends light=0.
 */

import { CHUNK_SIZE, LIGHT_MASK, LIGHT_MAX, MATERIAL_SHIFT, MATERIAL_MASK } from './constants.js';
import { isVoxelSolid } from './voxelData.js';
import { MATERIAL_TYPE_LUT, MAT_TYPE_SOLID } from '../materials/Materials.js';

/** Stride constants for flat index = x + y*CHUNK_SIZE + z*CHUNK_SIZE² */
const Y_STRIDE = CHUNK_SIZE;
const Z_STRIDE = CHUNK_SIZE * CHUNK_SIZE;

/** Inverse light mask for clearing light bits: ~0b11111 */
const LIGHT_CLEAR = ~LIGHT_MASK;

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
