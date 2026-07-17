/**
 * Region-relight correctness test (P3).
 *
 * relightRegion() is the single lighting orchestration shared by edit commit, build preview, and
 * the off-thread lighting worker. Its core promise: relighting a SUB-REGION with the surrounding
 * chunks supplied as read-only context reproduces exactly the light a full-world relight produces
 * for those chunks. This test locks that in — it is the headless stand-in for "the worker computes
 * the same light the main thread would", since the worker runs this exact function over a snapshot.
 */

import { describe, it, expect } from 'vitest';
import {
  CHUNK_SIZE,
  VOXELS_PER_CHUNK,
  packVoxel,
  voxelIndex,
  chunkKey,
  relightRegion,
  type RelightTarget,
} from '../index.js';

const CS = CHUNK_SIZE;
const LAVA = 50; // emissive material (MATERIAL_EMISSION_LUT[50] = 31)

/** Build a 3×3×3 chunk world: solid below global y=48, air above, one lava emitter in the middle. */
function buildWorld(): Map<string, Uint32Array> {
  const map = new Map<string, Uint32Array>();
  for (let cz = 0; cz < 3; cz++)
    for (let cy = 0; cy < 3; cy++)
      for (let cx = 0; cx < 3; cx++) {
        const data = new Uint32Array(VOXELS_PER_CHUNK);
        for (let lz = 0; lz < CS; lz++)
          for (let ly = 0; ly < CS; ly++)
            for (let lx = 0; lx < CS; lx++) {
              const gy = cy * CS + ly;
              const solid = gy < 48;
              data[voxelIndex(lx, ly, lz)] = packVoxel(solid ? 0.4 : -0.4, solid ? 1 : 0, 0);
            }
        map.set(chunkKey(cx, cy, cz), data);
      }
  // Lava emitter in the air of the centre chunk (global 48,50,48 → chunk 1,1,1 local 16,18,16).
  const centre = map.get(chunkKey(1, 1, 1))!;
  centre[voxelIndex(16, 18, 16)] = packVoxel(0.4, LAVA, 0);
  return map;
}

/** All chunk keys in a 3×3×3 world. */
function allKeys(): string[] {
  const keys: string[] = [];
  for (let cz = 0; cz < 3; cz++)
    for (let cy = 0; cy < 3; cy++)
      for (let cx = 0; cx < 3; cx++) keys.push(chunkKey(cx, cy, cz));
  return keys;
}

function target(cx: number, cy: number, cz: number): RelightTarget {
  return { cx, cy, cz, sky: true, block: true };
}

function getter(map: Map<string, Uint32Array>) {
  return (cx: number, cy: number, cz: number): Uint32Array | null =>
    map.get(chunkKey(cx, cy, cz)) ?? null;
}

describe('relightRegion', () => {
  it('reconstructs a sub-region from context identically to a full-world relight', () => {
    // Ground truth: relight the WHOLE world (top-down sky, block to fixed point).
    const full = buildWorld();
    const fullTargets = allKeys()
      .map((k) => { const [cx, cy, cz] = k.split(',').map(Number); return target(cx, cy, cz); })
      .sort((a, b) => b.cy - a.cy);
    relightRegion(getter(full), fullTargets);

    // A stale copy where an inner column's light is zeroed; the rest is left at ground-truth light
    // (read-only context). Zeroing both light fields simulates "these chunks need relighting".
    const partial = new Map<string, Uint32Array>();
    for (const [k, data] of full) partial.set(k, new Uint32Array(data));
    const column: Array<[number, number, number]> = [[1, 0, 1], [1, 1, 1], [1, 2, 1]];
    const LIGHT_AND_BLOCK = 0x1f | (0x1f << 16); // sky bits 0-4 + block bits 16-20
    for (const [cx, cy, cz] of column) {
      const data = partial.get(chunkKey(cx, cy, cz))!;
      for (let i = 0; i < VOXELS_PER_CHUNK; i++) data[i] &= ~LIGHT_AND_BLOCK;
    }

    // Relight ONLY the column; surrounding chunks are context.
    const columnTargets = column.map(([cx, cy, cz]) => target(cx, cy, cz)).sort((a, b) => b.cy - a.cy);
    relightRegion(getter(partial), columnTargets);

    // The column must now match ground truth bit-for-bit (sky + block).
    let sawSky = false;
    let sawBlock = false;
    for (const [cx, cy, cz] of column) {
      const ref = full.get(chunkKey(cx, cy, cz))!;
      const got = partial.get(chunkKey(cx, cy, cz))!;
      for (let i = 0; i < VOXELS_PER_CHUNK; i++) {
        expect(got[i] & LIGHT_AND_BLOCK).toBe(ref[i] & LIGHT_AND_BLOCK);
        if (ref[i] & 0x1f) sawSky = true;
        if (ref[i] & (0x1f << 16)) sawBlock = true;
      }
    }
    // Guard against a vacuous pass.
    expect(sawSky).toBe(true);
    expect(sawBlock).toBe(true);
  });

  it('skips the block pass entirely when no target opts in', () => {
    const map = buildWorld();
    // Sky-only targets: block light must stay zero everywhere.
    const skyTargets = allKeys()
      .map((k) => { const [cx, cy, cz] = k.split(',').map(Number); return { cx, cy, cz, sky: true, block: false }; })
      .sort((a, b) => b.cy - a.cy);
    relightRegion(getter(map), skyTargets);
    for (const data of map.values()) {
      for (let i = 0; i < VOXELS_PER_CHUNK; i++) {
        expect((data[i] >>> 16) & 0x1f).toBe(0);
      }
    }
  });
});
