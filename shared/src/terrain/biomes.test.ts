import { describe, it, expect } from 'vitest';
import { TerrainGenerator, DEFAULT_TERRAIN_LAYER_CONFIG, DEFAULT_CAVE_CONFIG, DEFAULT_BIOMES, DEBUG_BIOME_MATERIALS } from './TerrainGenerator.js';
import { cellValueToBiomeId } from './Biome.js';
import { BiomeSpawnSampler } from './BiomeSpawnSampler.js';
import { mat } from '../materials/index.js';

/**
 * VISIBILITY GUARD for the biomes layer. Per docs/terrain-generation-performance.md §3, a new terrain
 * feature ships a visibility assertion so it can't silently generate nothing.
 */
// Biomes are "on" when ≥1 is enabled; enable the whole default palette so all types are exercised.
const ALL_BIOMES = DEFAULT_BIOMES.map((b) => ({ ...b, enabled: true }));
function biomeGen() {
  return new TerrainGenerator({
    seed: 12345,
    terrainLayer: { ...DEFAULT_TERRAIN_LAYER_CONFIG, landformEnabled: true, biomes: ALL_BIOMES },
    caveConfig: { ...DEFAULT_CAVE_CONFIG, wormsEnabled: false, cavernsEnabled: false },
  }) as unknown as {
    biomeIdAt(x: number, z: number): number;
    sampleHeight(x: number, z: number): number;
    sampleSurface(x: number, z: number): { height: number; material: number };
  };
}

describe('cellValueToBiomeId', () => {
  it('maps into 0..n-1 and is stable', () => {
    for (let i = 0; i < 100; i++) {
      const v = (i / 100) * 2 - 1;   // spread across [-1,1)
      const id = cellValueToBiomeId(v, 3);
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThan(3);
      expect(cellValueToBiomeId(v, 3)).toBe(id);   // deterministic
    }
    expect(cellValueToBiomeId(0.5, 1)).toBe(0);    // n<=1 → always 0
  });
});

describe('biomes layer is visible', () => {
  it('partitions the world into multiple biomes', () => {
    const gen = biomeGen();
    const seen = new Set<number>();
    for (let x = -800; x <= 800; x += 16)
      for (let z = -800; z <= 800; z += 16) seen.add(gen.biomeIdAt(x, z));
    expect(seen.size).toBeGreaterThanOrEqual(2);          // more than one biome appears
    expect(seen.size).toBeLessThanOrEqual(DEFAULT_BIOMES.length);
  });

  it('produces distinct biome surface materials (grassland + desert tops somewhere on land)', () => {
    const gen = biomeGen();
    const SEA = DEFAULT_TERRAIN_LAYER_CONFIG.landformSeaLevel;
    let grass = 0, desert = 0;
    for (let x = -1200; x <= 1200; x += 12) {
      for (let z = -1200; z <= 1200; z += 12) {
        const s = gen.sampleSurface(x, z);
        if (s.height <= SEA + 12) continue;              // skip sea/beach — want inland biome surface
        if (s.material === mat('moss2')) grass++;         // Grassland top
        if (s.material === mat('roof')) desert++;         // Desert top (distinct from beach sand)
      }
    }
    expect(grass).toBeGreaterThan(50);    // Grassland biome present
    expect(desert).toBeGreaterThan(50);   // Desert biome present inland
  });

  it('debug mode flattens land columns to biome materials (no rock/snow/sand above sea)', () => {
    const gen = new TerrainGenerator({
      seed: 12345,
      terrainLayer: { ...DEFAULT_TERRAIN_LAYER_CONFIG, enabled: false, landformEnabled: true, biomes: ALL_BIOMES, biomesDebug: true },
      caveConfig: { ...DEFAULT_CAVE_CONFIG, wormsEnabled: false, cavernsEnabled: false },
    }) as unknown as { sampleSurface(x: number, z: number): { height: number; material: number } };
    const SEA = DEFAULT_TERRAIN_LAYER_CONFIG.landformSeaLevel;
    const debugColors = new Set(DEBUG_BIOME_MATERIALS);
    let landCols = 0;
    for (let x = -1000; x <= 1000; x += 16) {
      for (let z = -1000; z <= 1000; z += 16) {
        const s = gen.sampleSurface(x, z);
        if (s.height <= SEA) continue;            // above-sea land columns only (sea/rivers stay water)
        landCols++;
        expect(debugColors.has(s.material)).toBe(true);   // every land column is a flat debug color
      }
    }
    expect(landCols).toBeGreaterThan(50);
  });
});

describe('BiomeSpawnSampler matches the generator (drift guard)', () => {
  const cfg = { ...DEFAULT_TERRAIN_LAYER_CONFIG, landformEnabled: true, biomes: ALL_BIOMES };
  const gen = new TerrainGenerator({
    seed: 12345, terrainLayer: cfg,
    caveConfig: { ...DEFAULT_CAVE_CONFIG, wormsEnabled: false, cavernsEnabled: false },
  }) as unknown as { biomeIdAt(x: number, z: number): number };
  const sampler = new BiomeSpawnSampler(12345, cfg);

  it('agrees with the generator biomeIdAt across a grid', () => {
    for (let x = -600; x <= 600; x += 40)
      for (let z = -600; z <= 600; z += 40)
        expect(sampler.biomeIdAt(x, z)).toBe(gen.biomeIdAt(x, z));
  });

  it('findSpawn returns a land cell of the requested biome', () => {
    for (let b = 0; b < DEFAULT_BIOMES.length; b++) {
      const spot = sampler.findSpawn(b);
      expect(spot).not.toBeNull();
      expect(sampler.biomeIdAt(spot!.x, spot!.z)).toBe(b);
      expect(sampler.isLand(spot!.x, spot!.z)).toBe(true);
    }
  });
});
