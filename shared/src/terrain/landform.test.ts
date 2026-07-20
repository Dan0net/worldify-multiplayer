import { describe, it, expect } from 'vitest';
import { TerrainGenerator, DEFAULT_TERRAIN_LAYER_CONFIG, DEFAULT_CAVE_CONFIG } from './TerrainGenerator.js';
import { CHUNK_SIZE, VOXEL_SCALE } from '../voxel/constants.js';
import { getMaterial, getWeight } from '../voxel/voxelData.js';
import { mat } from '../materials/index.js';

/**
 * VISIBILITY GUARD for the landform layer (sea / beach / plains / mountains). Per
 * docs/terrain-generation-performance.md §3, a new terrain feature ships a visibility assertion so it
 * can't silently generate nothing (the cavern-spikes lesson).
 */
function landformGen() {
  return new TerrainGenerator({
    seed: 12345,
    terrainLayer: { ...DEFAULT_TERRAIN_LAYER_CONFIG, landformEnabled: true },
    caveConfig: { ...DEFAULT_CAVE_CONFIG, wormsEnabled: false, cavernsEnabled: false },
  }) as unknown as {
    sampleHeight(x: number, z: number): number;
    sampleSurface(x: number, z: number): { height: number; material: number };
    generateChunk(cx: number, cy: number, cz: number): Uint32Array;
  };
}

const SEA = DEFAULT_TERRAIN_LAYER_CONFIG.landformSeaLevel;
const MTN = DEFAULT_TERRAIN_LAYER_CONFIG.landformMountainHeight;

describe('landform layer is visible', () => {
  it('spans sea → beach → plains → mountains', () => {
    const gen = landformGen();
    let minH = Infinity, maxH = -Infinity, sand = 0, submerged = 0, cols = 0;
    // ~1.6 km grid → several landmasses at the continental frequency
    for (let x = -800; x <= 800; x += 8) {
      for (let z = -800; z <= 800; z += 8) {
        cols++;
        const h = gen.sampleHeight(x, z);
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
        if (h < SEA) submerged++;
        if (gen.sampleSurface(x, z).material === mat('sand')) sand++;
      }
    }
    expect(minH).toBeLessThan(SEA);                 // sea floor dips below sea level
    expect(maxH).toBeGreaterThan(SEA + MTN * 0.4);  // mountains rise well above sea
    expect(submerged / cols).toBeGreaterThan(0.15); // a meaningful fraction is ocean
    expect(sand).toBeGreaterThan(50);               // a beach sand band exists
  });

  it('floods submerged columns with water', () => {
    const gen = landformGen();
    const waterMat = (gen as unknown as { config: { pathwayConfig: { waterMaterial: number } } }).config.pathwayConfig.waterMaterial;
    // Find a submerged tile, generate its column around sea level, count water voxels.
    let water = 0;
    const seaCy = Math.floor(SEA / CHUNK_SIZE);
    outer:
    for (let cx = -20; cx < 20; cx++) {
      for (let cz = -20; cz < 20; cz++) {
        const wx = (cx * CHUNK_SIZE + 16) * VOXEL_SCALE, wz = (cz * CHUNK_SIZE + 16) * VOXEL_SCALE;
        if (gen.sampleHeight(wx, wz) >= SEA) continue;
        for (let cy = seaCy - 2; cy <= seaCy + 1; cy++) {
          const d = gen.generateChunk(cx, cy, cz);
          for (let i = 0; i < d.length; i++)
            if (getMaterial(d[i]) === waterMat && getWeight(d[i]) > 0) water++;
        }
        if (water > 0) break outer;
      }
    }
    expect(water).toBeGreaterThan(200);   // a real body of sea water, not a stray voxel
  });

  it('keeps material bands proportional at small master scale (not all sand)', () => {
    // Regression guard: heights are vertically scaled by masterScale, so the sand/snow bands must scale
    // too — otherwise at a small scale everything compresses near sea level and reads as sand.
    const gen = new TerrainGenerator({
      seed: 12345,
      terrainLayer: { ...DEFAULT_TERRAIN_LAYER_CONFIG, landformEnabled: true, masterScale: 0.2 },
      caveConfig: { ...DEFAULT_CAVE_CONFIG, wormsEnabled: false, cavernsEnabled: false },
    }) as unknown as { sampleSurface(x: number, z: number): { height: number; material: number } };
    let sand = 0, land = 0, cols = 0;
    for (let x = -300; x <= 300; x += 4) {
      for (let z = -300; z <= 300; z += 4) {
        cols++;
        const m = gen.sampleSurface(x, z).material;
        if (m === mat('sand')) sand++;
        if (m === mat('moss2') || m === mat('rock') || m === mat('snow')) land++;
      }
    }
    expect(sand / cols).toBeLessThan(0.5);   // sand is a band, not the whole world
    expect(land).toBeGreaterThan(50);         // grass/rock/snow land still exists at small scale
  });

  it('has visible surface detail (not glassy-smooth)', () => {
    // Regression guard: the detail noise once double-applied frequency (via GetNoise coordinate scaling
    // × the noise's internal frequency) → a ~km wavelength that read as perfectly smooth. Assert that a
    // small patch of adjacent land columns actually varies at the fine detail scale.
    const gen = landformGen();
    // Find a land patch above the beach, then measure local height spread over a few metres.
    let maxSpread = 0;
    for (let bx = 0; bx < 400 && maxSpread < 3; bx += 20) {
      const cx = bx + 4, cz = 4;
      if (gen.sampleHeight(cx, cz) <= SEA + 12) continue;   // want land, not sea/beach
      let mn = Infinity, mx = -Infinity;
      for (let dx = 0; dx < 8; dx++) {
        for (let dz = 0; dz < 8; dz++) {
          const h = gen.sampleHeight(cx + dx, cz + dz);      // ~2 m steps
          if (h < mn) mn = h;
          if (h > mx) mx = h;
        }
      }
      maxSpread = Math.max(maxSpread, mx - mn);
    }
    expect(maxSpread).toBeGreaterThan(3);   // several voxels of local relief → detail is present
  });
});
