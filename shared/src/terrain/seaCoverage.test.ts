import { describe, it, expect } from 'vitest';
import { TerrainGenerator, DEFAULT_TERRAIN_LAYER_CONFIG, DEFAULT_CAVE_CONFIG } from './TerrainGenerator.js';
import { mat } from '../materials/index.js';

/**
 * Guards for the KISS landform surface: elevation/slope material zones (sea / sand / snow / steep rock /
 * moss-grass) and the "Sea coverage %" control. Per docs/terrain-generation-performance.md §3 a terrain
 * feature ships a visibility assertion.
 */
function gen(seaCoveragePercent: number) {
  return new TerrainGenerator({
    seed: 4242,
    terrainLayer: { ...DEFAULT_TERRAIN_LAYER_CONFIG, enabled: false, landformEnabled: true, seaCoveragePercent },
    caveConfig: { ...DEFAULT_CAVE_CONFIG, wormsEnabled: false, cavernsEnabled: false },
  }) as unknown as { sampleSurface(x: number, z: number): { height: number; material: number } };
}

/** Count columns whose surface reads as water (below sea) over a fixed sampled area. */
function seaColumns(g: ReturnType<typeof gen>): number {
  let sea = 0, total = 0;
  for (let x = -1600; x <= 1600; x += 32)
    for (let z = -1600; z <= 1600; z += 32) { total++; if (g.sampleSurface(x, z).material === mat('water')) sea++; }
  return sea / total;
}

describe('sea coverage control', () => {
  it('more coverage → more ocean', () => {
    const low = seaColumns(gen(20));
    const high = seaColumns(gen(70));
    expect(high).toBeGreaterThan(low);
    expect(low).toBeLessThan(0.5);
    expect(high).toBeGreaterThan(0.4);
  });
});

describe('landform surface zones are visible', () => {
  it('produces water, sand, moss/grass and snow somewhere', () => {
    const g = gen(45);
    const seen = new Set<number>();
    for (let x = -2000; x <= 2000; x += 16)
      for (let z = -2000; z <= 2000; z += 16) seen.add(g.sampleSurface(x, z).material);
    expect(seen.has(mat('water'))).toBe(true);   // sea
    expect(seen.has(mat('sand'))).toBe(true);     // beach
    expect(seen.has(mat('moss2'))).toBe(true);    // grass
    expect(seen.has(mat('snow'))).toBe(true);     // snow caps
  });
});
