import { describe, it, expect } from 'vitest';
import { TerrainGenerator, DEFAULT_TERRAIN_LAYER_CONFIG, DEFAULT_CAVE_CONFIG } from './TerrainGenerator.js';
import { CHUNK_SIZE, VOXEL_SCALE } from '../voxel/constants.js';
import { getMaterial, getWeight } from '../voxel/voxelData.js';

/**
 * VISIBILITY GUARD for the rivers layer (natural cellular water channels, separate from paths). Per
 * docs/terrain-generation-performance.md §3, a new terrain feature ships a visibility assertion so it
 * can't silently generate nothing (the cavern-spikes lesson).
 */
function riverGen() {
  return new TerrainGenerator({
    seed: 12345,
    terrainLayer: { ...DEFAULT_TERRAIN_LAYER_CONFIG, landformEnabled: true, riversEnabled: true },
    caveConfig: { ...DEFAULT_CAVE_CONFIG, wormsEnabled: false, cavernsEnabled: false },
  }) as unknown as {
    isOnRiver(x: number, z: number): boolean;
    sampleHeight(x: number, z: number): number;
    generateChunk(cx: number, cy: number, cz: number): Uint32Array;
    config: { pathwayConfig: { waterMaterial: number } };
  };
}

describe('rivers layer is visible', () => {
  it('marks a meaningful number of river columns', () => {
    const gen = riverGen();
    let onRiver = 0, cols = 0;
    for (let x = -800; x <= 800; x += 8) {
      for (let z = -800; z <= 800; z += 8) {
        cols++;
        if (gen.isOnRiver(x, z)) onRiver++;
      }
    }
    expect(onRiver).toBeGreaterThan(50);          // river channels exist across the sampled area
    expect(onRiver / cols).toBeLessThan(0.5);      // and they're channels, not flooding everything
  });

  it('fills a river channel with water', () => {
    const gen = riverGen();
    const waterMat = gen.config.pathwayConfig.waterMaterial;
    let water = 0;
    outer:
    for (let cx = -25; cx < 25; cx++) {
      for (let cz = -25; cz < 25; cz++) {
        const wx = (cx * CHUNK_SIZE + 16) * VOXEL_SCALE, wz = (cz * CHUNK_SIZE + 16) * VOXEL_SCALE;
        if (!gen.isOnRiver(wx, wz)) continue;
        const sh = gen.sampleHeight(wx, wz);
        const cy = Math.floor(sh / CHUNK_SIZE);
        for (let dy = -1; dy <= 1; dy++) {
          const d = gen.generateChunk(cx, cy + dy, cz);
          for (let i = 0; i < d.length; i++)
            if (getMaterial(d[i]) === waterMat && getWeight(d[i]) > 0) water++;
        }
        if (water > 0) break outer;
      }
    }
    expect(water).toBeGreaterThan(20);   // a real body of river water
  });
});
