import { describe, it, expect } from 'vitest';
import { TerrainGenerator, DEFAULT_TERRAIN_LAYER_CONFIG, DEFAULT_CAVE_CONFIG } from './TerrainGenerator.js';
import { CHUNK_SIZE, VOXEL_SCALE } from '../voxel/constants.js';
import { getMaterial, getWeight } from '../voxel/voxelData.js';

/**
 * VISIBILITY GUARD for the rivers layer (HYDROLOGY: sources seeded on highland, traced downhill along
 * the heightmap). Per docs/terrain-generation-performance.md §3 a terrain feature ships a visibility
 * assertion so it can't silently generate nothing — and here also that rivers follow the terrain
 * (they lie in the low ground, not perched on peaks) and reach water, the whole point of the redesign.
 */
function riverGen() {
  return new TerrainGenerator({
    seed: 12345,
    // River-friendly tuning so the guard reliably has rivers to find (denser/lower/longer than default).
    terrainLayer: {
      ...DEFAULT_TERRAIN_LAYER_CONFIG, landformEnabled: true, riversEnabled: true,
      riverSourceSpacing: 200, riverSourceMinElevation: 0.2, riverMaxLength: 800,
    },
    caveConfig: { ...DEFAULT_CAVE_CONFIG, wormsEnabled: false, cavernsEnabled: false },
  }) as unknown as {
    isOnRiver(x: number, z: number): boolean;
    sampleHeight(x: number, z: number): number;
    generateChunk(cx: number, cy: number, cz: number): Uint32Array;
    config: { pathwayConfig: { waterMaterial: number } };
  };
}

describe('rivers (hydrology) follow the terrain', () => {
  it('traces rivers that are not perched on peaks (they run down the terrain)', () => {
    const gen = riverGen();
    const found: { x: number; z: number }[] = [];
    for (let x = -2400; x <= 2400 && found.length < 60; x += 8)
      for (let z = -2400; z <= 2400 && found.length < 60; z += 8)
        if (gen.isOnRiver(x, z)) found.push({ x, z });
    expect(found.length).toBeGreaterThan(10);   // rivers exist across the sampled area

    // A downhill trace always has higher ground behind it, so a river column is never a local maximum:
    // at least one neighbour (uncarved) is higher. Encodes "runs down the terrain", not along ridges.
    let notPeak = 0;
    for (const c of found) {
      const h = gen.sampleHeight(c.x, c.z);
      const hi = Math.max(
        gen.sampleHeight(c.x + 16, c.z), gen.sampleHeight(c.x - 16, c.z),
        gen.sampleHeight(c.x, c.z + 16), gen.sampleHeight(c.x, c.z - 16),
      );
      if (hi >= h) notPeak++;
    }
    expect(notPeak / found.length).toBeGreaterThan(0.8);
  });

  it('fills a river channel with water', () => {
    const gen = riverGen();
    const waterMat = gen.config.pathwayConfig.waterMaterial;
    let water = 0;
    outer:
    for (let x = -2400; x <= 2400; x += 8) {
      for (let z = -2400; z <= 2400; z += 8) {
        if (!gen.isOnRiver(x, z)) continue;
        const cx = Math.floor(x / (CHUNK_SIZE * VOXEL_SCALE)), cz = Math.floor(z / (CHUNK_SIZE * VOXEL_SCALE));
        const sh = gen.sampleHeight(x, z);
        const cy = Math.floor(sh / CHUNK_SIZE);
        for (let dy = -1; dy <= 1; dy++) {
          const d = gen.generateChunk(cx, cy + dy, cz);
          for (let i = 0; i < d.length; i++)
            if (getMaterial(d[i]) === waterMat && getWeight(d[i]) > 0) water++;
        }
        if (water > 0) break outer;
      }
    }
    expect(water).toBeGreaterThan(10);   // a real body of river water
  });
});
