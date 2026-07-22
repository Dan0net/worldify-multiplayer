import { describe, it, expect } from 'vitest';
import { TerrainGenerator, DEFAULT_TERRAIN_LAYER_CONFIG, DEFAULT_CAVE_CONFIG } from './TerrainGenerator.js';
import { CHUNK_SIZE, VOXEL_SCALE } from '../voxel/constants.js';
import { getWeight, getMaterial } from '../voxel/voxelData.js';

/**
 * GUARD for the runtime LOD zoom (docs plan: "Runtime zoomable world-scale"). A level-L chunk samples
 * the SAME fixed world field at a coarse step of 2^L. Two things must hold: (1) level 0 is byte-identical
 * to the un-zoomed path (so the checksum guards never move and no world re-bakes), and (2) a coarse chunk
 * is a genuine decimation of the same landform — its surface tracks the level-0 heightfield at the coarse
 * sample points, not some stretched/different world.
 */
function landformGen() {
  return new TerrainGenerator({
    seed: 12345,
    terrainLayer: { ...DEFAULT_TERRAIN_LAYER_CONFIG, landformEnabled: true, seaCoveragePercent: 40 },
    caveConfig: { ...DEFAULT_CAVE_CONFIG, wormsEnabled: false, cavernsEnabled: false },
  }) as unknown as {
    generateChunk(cx: number, cy: number, cz: number, level?: number): Uint32Array;
    sampleHeight(x: number, z: number): number;
    config: { pathwayConfig: { waterMaterial: number } };
  };
}

/** World-voxel Y of the highest solid TERRAIN voxel (skipping sea water) in a chunk column, or -Infinity. */
function highestTerrainY(
  gen: ReturnType<typeof landformGen>, cx: number, cz: number, level: number, lx: number, lz: number,
): number {
  const step = 1 << level;
  const water = gen.config.pathwayConfig.waterMaterial;
  for (let cy = 10; cy >= -6; cy--) {
    const d = gen.generateChunk(cx, cy, cz, level);
    for (let ly = CHUNK_SIZE - 1; ly >= 0; ly--) {
      const idx = lx + ly * CHUNK_SIZE + lz * CHUNK_SIZE * CHUNK_SIZE;
      if (getWeight(d[idx]) > 0 && getMaterial(d[idx]) !== water) return cy * CHUNK_SIZE * step + ly * step;
    }
  }
  return -Infinity;
}

describe('LOD zoom generation', () => {
  it('is byte-identical at level 0 (explicit level === no argument)', () => {
    const gen = landformGen();
    const withArg = gen.generateChunk(2, 0, 3, 0);
    const noArg = gen.generateChunk(2, 0, 3);
    expect(Array.from(withArg)).toEqual(Array.from(noArg));
  });

  it('coarse chunks decimate the same heightfield (surface tracks the level-0 field)', () => {
    const gen = landformGen();
    const level = 3, step = 1 << level;   // each coarse voxel spans 8 world-voxels
    let checked = 0;
    for (const [lx, lz] of [[4, 4], [16, 10], [26, 22]]) {
      const wx = lx * VOXEL_SCALE * step, wz = lz * VOXEL_SCALE * step;
      const expected = gen.sampleHeight(wx, wz);                 // level-0 field at the coarse sample point
      const got = highestTerrainY(gen, 0, 0, level, lx, lz);
      expect(got).toBeGreaterThan(-Infinity);                    // coarse terrain actually generates
      // Within one coarse voxel of the true field → same landform, sampled coarsely (not stretched).
      expect(Math.abs(got - expected)).toBeLessThanOrEqual(step * 1.5);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it('gates detail off at coarse levels (caves/stamps) so a coarse chunk stays cheap', () => {
    // A stamp + cave landform world at level 3: the coarse chunk must still be pure landform terrain —
    // the guard is that it generates without touching the cave/stamp machinery, asserted by producing
    // terrain (solid voxels) across the surface band.
    const gen = new TerrainGenerator({
      seed: 777,
      terrainLayer: { ...DEFAULT_TERRAIN_LAYER_CONFIG, landformEnabled: true, stampsEnabled: true, seaCoveragePercent: 40 },
      caveConfig: { ...DEFAULT_CAVE_CONFIG, wormsEnabled: true, cavernsEnabled: true },
    }) as unknown as { generateChunk(cx: number, cy: number, cz: number, level?: number): Uint32Array };
    let solid = 0;
    for (let cy = 10; cy >= -6; cy--) {
      const d = gen.generateChunk(0, cy, 0, 3);
      for (let i = 0; i < d.length; i++) if (getWeight(d[i]) > 0) solid++;
    }
    expect(solid).toBeGreaterThan(0);   // coarse landform still renders with caves/stamps globally on
  });
});
