/**
 * Voxel lighting — sunlight column propagation
 *
 * Scans each (x,z) column top-down. Sky-exposed non-solid voxels get LIGHT_MAX (31).
 * Solid voxels stop the column. Light is written directly into the packed 16-bit data
 * using bit ops (light occupies the bottom 5 bits).
 *
 * This runs client-side before meshing — server sends light=0.
 */

import { CHUNK_SIZE, LIGHT_MASK, LIGHT_MAX } from './constants.js';
import { isVoxelSolid } from './voxelData.js';

/** Stride constants for flat index = x + y*CHUNK_SIZE + z*CHUNK_SIZE² */
const Y_STRIDE = CHUNK_SIZE;
const Z_STRIDE = CHUNK_SIZE * CHUNK_SIZE;

/** Inverse light mask for clearing light bits: ~0b11111 */
const LIGHT_CLEAR = ~LIGHT_MASK;

/**
 * Propagate sunlight columns through a chunk's voxel data (in-place).
 *
 * For each (lx, lz) column, determines whether sunlight enters from above,
 * then scans downward: non-solid voxels receive LIGHT_MAX, solid voxels stop
 * the column.
 *
 * @param data          The chunk's Uint16Array (CHUNK_SIZE³ entries), modified in-place
 * @param isSunlitAbove Per-column boolean: whether sunlight enters the top of this chunk.
 *                      Flat array of CHUNK_SIZE² values indexed as [lx + lz * CHUNK_SIZE].
 *                      If null, every column is assumed sunlit from above.
 * @returns             Per-column boolean: whether sunlight exits the bottom of this chunk.
 *                      Same layout as isSunlitAbove. Caller uses this to propagate to chunk below.
 */
export function computeSunlightColumns(
  data: Uint16Array,
  isSunlitAbove: Uint8Array | null,
): Uint8Array {
  const sunlitBelow = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);

  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    const zOff = lz * Z_STRIDE;
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const colBase = lx + zOff;
      let lit = isSunlitAbove ? isSunlitAbove[lx + lz * CHUNK_SIZE] !== 0 : true;

      // Scan top (ly=31) down to bottom (ly=0)
      for (let ly = CHUNK_SIZE - 1; ly >= 0; ly--) {
        const idx = colBase + ly * Y_STRIDE;
        const voxel = data[idx];

        if (lit && !isVoxelSolid(voxel)) {
          // Set light to LIGHT_MAX — clear old light bits, OR in max
          data[idx] = (voxel & LIGHT_CLEAR) | LIGHT_MAX;
        } else {
          if (isVoxelSolid(voxel)) {
            lit = false;
          }
          // Clear light for non-sunlit voxels
          data[idx] = voxel & LIGHT_CLEAR;
        }
      }

      sunlitBelow[lx + lz * CHUNK_SIZE] = lit ? 1 : 0;
    }
  }

  return sunlitBelow;
}

/**
 * Build the isSunlitAbove array for a chunk by checking the chunk directly above.
 *
 * If there is no chunk above:
 *   - cy >= maxCy → assume full sunlight (return null, meaning all-sunlit)
 *   - cy < maxCy  → assume dark (return all-zero array)
 *
 * If there IS a chunk above, scan its bottom row (ly=0) per column:
 *   sunlit if the bottom voxel is non-solid AND has light == LIGHT_MAX.
 *
 * @param chunkAboveData  Voxel data of the chunk at (cx, cy+1, cz), or undefined
 * @param cy              This chunk's Y coordinate
 * @param maxCy           The highest chunk Y that contains terrain in this column
 * @returns               Uint8Array(CHUNK_SIZE²) or null (null = all sunlit)
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
      // Sunlit if non-solid and has full light
      if (!isVoxelSolid(voxel) && (voxel & LIGHT_MASK) === LIGHT_MAX) {
        result[lx + lz * CHUNK_SIZE] = 1;
      }
    }
  }
  return result;
}
