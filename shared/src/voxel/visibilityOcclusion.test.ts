/**
 * Occluder-threshold test for the visibility graph (P6 / Win 1).
 *
 * A voxel must block the visibility flood-fill exactly when the mesher draws it as solid
 * (weight > SURFACE_PACKED_THRESHOLD), not only when it is at maximum weight. This guards the fix:
 * a partial-but-solid wall (rendered rock, but below max weight) must separate the two air regions
 * either side of it, so the chunk's opposing faces do NOT "see through" the wall.
 */

import { describe, it, expect } from 'vitest';
import {
  CHUNK_SIZE,
  VOXELS_PER_CHUNK,
  packVoxel,
  voxelIndex,
  computeVisibility,
  canSeeThrough,
  ChunkFace,
} from '../index.js';

const CS = CHUNK_SIZE;
const WALL_X = CS >> 1; // 16

/** All-air chunk except a full y,z wall at x=WALL_X built from the given voxel word. */
function chunkWithWall(wallVoxel: number): Uint32Array {
  const air = packVoxel(-0.4, 0, 0); // weight well below the surface crossing → see-through
  const data = new Uint32Array(VOXELS_PER_CHUNK).fill(air);
  for (let z = 0; z < CS; z++)
    for (let y = 0; y < CS; y++) data[voxelIndex(WALL_X, y, z)] = wallVoxel;
  return data;
}

describe('visibility occluder threshold', () => {
  it('a partial-but-solid wall (below max weight) occludes across the chunk', () => {
    // weight 0.1 packs to ~9 — above SURFACE_PACKED_THRESHOLD (7, so rendered solid) but well below
    // max (15). Under the old max-weight-only rule this leaked; it must now block.
    const bits = computeVisibility(chunkWithWall(packVoxel(0.1, 1, 0)));
    expect(canSeeThrough(bits, ChunkFace.POS_X, ChunkFace.NEG_X)).toBe(false);
    // The wall spans only X, so each air half still connects its own side faces — sight across the
    // wall is what's blocked, not all visibility.
    expect(canSeeThrough(bits, ChunkFace.POS_Y, ChunkFace.NEG_Y)).toBe(true);
  });

  it('a full-strength wall occludes too', () => {
    const bits = computeVisibility(chunkWithWall(packVoxel(0.5, 1, 0)));
    expect(canSeeThrough(bits, ChunkFace.POS_X, ChunkFace.NEG_X)).toBe(false);
  });

  it('a sub-threshold (air-weight) wall does NOT occlude — sight passes through', () => {
    // weight -0.05 packs to ~7 — not above the threshold, so it is air to both mesh and visibility.
    const bits = computeVisibility(chunkWithWall(packVoxel(-0.05, 1, 0)));
    expect(canSeeThrough(bits, ChunkFace.POS_X, ChunkFace.NEG_X)).toBe(true);
  });
});
