import { describe, it, expect } from 'vitest';
import { TerrainGenerator, DEFAULT_CAVE_CONFIG } from './TerrainGenerator.js';

/**
 * VISIBILITY GUARD for cavern stalagmites/stalactites.
 *
 * The spikes were effectively invisible from their first implementation until fixed — the checksum
 * guards don't cover a spiked cavern, so nothing asserted the feature actually produced anything. Per
 * docs/terrain-generation-performance.md §3, every terrain feature ships a visibility assertion. This is
 * that assertion for spikes: generate a cavern-dense region and require the spike predicate to (a) be
 * exercised and (b) return solid for a meaningful number of voxels.
 *
 * The safety asserts (function exists, evaluated > 0) make a future rename/inline fail LOUDLY here
 * rather than silently counting zero and passing.
 */
describe('cavern spikes are visible', () => {
  it('produces a meaningful number of solid stalagmite/stalactite voxels', () => {
    const gen = new TerrainGenerator({
      seed: 12345,
      caveConfig: { ...DEFAULT_CAVE_CONFIG, wormsEnabled: false }, // caverns only → spikes are isolated
    }) as unknown as {
      cavernSpikeSolid: (x: number, z: number, y: number, f: number, c: number) => boolean;
      generateChunk: (cx: number, cy: number, cz: number) => Uint32Array;
    };

    expect(typeof gen.cavernSpikeSolid).toBe('function'); // fail loudly if the predicate is renamed/inlined

    let calls = 0, solid = 0;
    const orig = gen.cavernSpikeSolid.bind(gen);
    gen.cavernSpikeSolid = (x, z, y, f, c) => { calls++; const r = orig(x, z, y, f, c); if (r) solid++; return r; };

    for (let cx = -2; cx <= 2; cx++)
      for (let cz = -2; cz <= 2; cz++)
        for (let cy = -8; cy <= 0; cy++)
          gen.generateChunk(cx, cy, cz);

    expect(calls).toBeGreaterThan(1000);  // caverns exist and the spike test is reached
    expect(solid).toBeGreaterThan(150);   // spikes are actually solid (was ~58 when broken; ~480 fixed)
  });
});
