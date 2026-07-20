/**
 * Terrain cost bench — committed profiling harness (NOT a normal unit test).
 *
 * Skipped by default so `npm run test:run` stays fast; run it explicitly:
 *     BENCH=1 npx vitest run shared/src/terrain/terrainCost.bench.test.ts
 *
 * Reports, per generated column:
 *   - GetNoise call COUNT by source (worms / caverns / height / pathway) — the reliable device-cost
 *     proxy (node under-weights noise ~10×, but call counts are exact).
 *   - cold TIME by layer (both caves / worms only / caverns only / terrain only), best-of-N to fight
 *     container wall-clock drift.
 *
 * See docs/terrain-generation-performance.md §4 for methodology and why node time ≠ device time.
 */
import { describe, it } from 'vitest';
import { TerrainGenerator, DEFAULT_CAVE_CONFIG, type CaveConfig } from './TerrainGenerator.js';
import { CHUNK_SIZE, VOXEL_SCALE } from '../voxel/constants.js';

// Every FastNoiseLite field on the generator, grouped by what it drives. Add new fields here when a
// feature introduces a noise source, so its call count stays visible.
const NOISE_GROUPS: Record<string, string[]> = {
  height: ['heightNoise', 'warpNoiseX', 'warpNoiseZ'],
  landform: ['landformWarpX', 'landformWarpZ', 'landformBase'],
  pathway: ['pathwayCellular', 'pathwayWarpX', 'pathwayWarpZ', 'pathwayMaterialNoise'],
  worms: ['caveWormSteerYaw', 'caveWormSteerPitch', 'caveWormRadius', 'caveWormWall'],
  caverns: ['caveCavernWarpX', 'caveCavernWarpY', 'caveCavernWarpZ', 'caveCavernWall'],
};

const COLD_TILES: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [40, 12], [-30, 25], [17, -44], [63, 51], [-52, -18], [88, -70], [-95, 33],
];

function instrument(gen: any): () => Record<string, number> {
  const counts: Record<string, number> = {};
  for (const fields of Object.values(NOISE_GROUPS)) {
    for (const f of fields) {
      counts[f] = 0;
      const nz = gen[f];
      if (!nz) continue;
      const orig = nz.GetNoise.bind(nz);
      nz.GetNoise = function (a: number, b: number, d?: number) {
        counts[f]++;
        return d === undefined ? orig(a, b) : orig(a, b, d);
      };
    }
  }
  return () => counts;
}

function genColumn(gen: TerrainGenerator, tx: number, tz: number): void {
  const wx = (tx * CHUNK_SIZE + 16) * VOXEL_SCALE, wz = (tz * CHUNK_SIZE + 16) * VOXEL_SCALE;
  const sh = (gen as unknown as { sampleHeight(x: number, z: number): number }).sampleHeight(wx, wz);
  const surfCy = Math.floor(sh / CHUNK_SIZE);
  for (let cy = surfCy - 5; cy <= surfCy + 1; cy++) gen.generateChunk(tx, cy, tz);
}

function coldTime(cfg: CaveConfig, reps = 5): number {
  let best = Infinity;
  for (let r = 0; r < reps; r++) {
    let ms = 0;
    for (const [tx, tz] of COLD_TILES) {
      const gen = new TerrainGenerator({ seed: 12345, caveConfig: cfg });
      const t = performance.now();
      genColumn(gen, tx, tz);
      ms += performance.now() - t;
    }
    best = Math.min(best, ms / COLD_TILES.length);
  }
  return best;
}

describe.skipIf(!process.env.BENCH)('terrain cost bench', () => {
  it('noise counts + cold time by layer', { timeout: 180000 }, () => {
    // ---- noise call counts (averaged over the cold tiles) ----
    const agg: Record<string, number> = {};
    for (const [tx, tz] of COLD_TILES) {
      const gen = new TerrainGenerator({ seed: 12345, caveConfig: DEFAULT_CAVE_CONFIG });
      const read = instrument(gen);
      genColumn(gen, tx, tz);
      const c = read();
      for (const k of Object.keys(c)) agg[k] = (agg[k] ?? 0) + c[k];
    }
    const n = COLD_TILES.length;
    const per = (fields: string[]) => Math.round(fields.reduce((s, f) => s + (agg[f] ?? 0), 0) / n);
    console.log('\n=== NOISE CALLS / column (cold) ===');
    let total = 0;
    for (const [group, fields] of Object.entries(NOISE_GROUPS)) {
      const v = per(fields); total += v;
      console.log(`  ${group.padEnd(8)} ${v}`);
    }
    console.log(`  ${'TOTAL'.padEnd(8)} ${total}`);

    // ---- cold time by layer ----
    console.log('\n=== COLD TIME / column (best-of-5, node — relative only) ===');
    console.log(`  both caves    ${coldTime(DEFAULT_CAVE_CONFIG).toFixed(1)} ms`);
    console.log(`  worms only    ${coldTime({ ...DEFAULT_CAVE_CONFIG, cavernsEnabled: false }).toFixed(1)} ms`);
    console.log(`  caverns only  ${coldTime({ ...DEFAULT_CAVE_CONFIG, wormsEnabled: false }).toFixed(1)} ms`);
    console.log(`  terrain only  ${coldTime({ ...DEFAULT_CAVE_CONFIG, wormsEnabled: false, cavernsEnabled: false }).toFixed(1)} ms`);
  });
});
