/**
 * genBench (28 build) — on-device generation timing, run from the DebugPanel. Fixed seed + column so
 * the numbers are directly comparable with the 70 / 70-terrain-only builds on the same device.
 * 28 has no caves, so there is a single config. Runs the real LocalTerrainSource on the main thread.
 */
import { LocalTerrainSource } from '../voxel/LocalTerrainSource.js';
import { computeAndPropagateLight, getSunlitAbove, computeVisibility } from '@worldify/shared';

const SEED = 12345;
const COLD_REPS = 5;
const WARM_COLS: ReadonlyArray<readonly [number, number]> = [[3, 0], [0, 3], [6, 6], [-4, 2]];

export interface GenBenchRow {
  label: string; chunks: number; constructMs: number; genColdMs: number;
  genWarmMs: number; ingest1Ms: number; ingestAllMs: number;
}

const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
const r1 = (n: number) => Math.round(n * 10) / 10;
const yieldFrame = () => new Promise<void>((res) => setTimeout(res, 0));

async function benchConfig(label: string): Promise<GenBenchRow> {
  const construct: number[] = [], genCold: number[] = [], ingest1: number[] = [], ingestAll: number[] = [];
  let chunks = 0;
  for (let rep = 0; rep < COLD_REPS; rep++) {
    let t = performance.now();
    const src = new LocalTerrainSource(SEED);
    construct.push(performance.now() - t);

    t = performance.now();
    const col = src.generateColumn(0, 0);
    genCold.push(performance.now() - t);
    chunks = col.chunks.length;

    const top = col.chunks[col.chunks.length - 1];
    t = performance.now();
    computeAndPropagateLight(top.voxelData, null, [null, null, null, null, null, null]);
    computeVisibility(top.voxelData);
    ingest1.push(performance.now() - t);

    t = performance.now();
    for (let i = col.chunks.length - 1; i >= 0; i--) {
      const c = col.chunks[i];
      const above = col.chunks[i + 1]?.voxelData;
      computeAndPropagateLight(c.voxelData, getSunlitAbove(above), [null, null, null, null, null, null]);
      computeVisibility(c.voxelData);
    }
    ingestAll.push(performance.now() - t);
    await yieldFrame();
  }

  const warmSrc = new LocalTerrainSource(SEED);
  warmSrc.generateColumn(0, 0);
  const genWarm: number[] = [];
  for (const [wx, wz] of WARM_COLS) {
    const t = performance.now();
    warmSrc.generateColumn(wx, wz);
    genWarm.push(performance.now() - t);
  }

  return {
    label, chunks,
    constructMs: r1(med(construct)), genColdMs: r1(med(genCold)), genWarmMs: r1(med(genWarm)),
    ingest1Ms: r1(med(ingest1)), ingestAllMs: r1(med(ingestAll)),
  };
}

export async function runGenBench(onRow?: (row: GenBenchRow) => void): Promise<GenBenchRow[]> {
  const row = await benchConfig('28 (no caves)');
  onRow?.(row);
  return [row];
}

export function deviceInfo(): string {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 0;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return `cores=${cores} | ${ua}`;
}
