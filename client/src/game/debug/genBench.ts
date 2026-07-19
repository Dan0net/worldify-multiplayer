/**
 * genBench — on-device generation timing, run from the DebugPanel. Measures the compute stages on
 * the path to a chunk's debug bounds: construct source → generate the bootstrap column (cold) →
 * generate warm follow-up columns → ingest (sunlight + visibility). Fixed seed + column so the
 * numbers are directly comparable across builds (28 / 70 / 70 terrain-only) and devices.
 *
 * Runs the REAL LocalTerrainSource on the main thread — that's the same CPU a terrain worker uses, so
 * the gen cost here is the real per-column device cost (excludes only worker postMessage, a few ms).
 */
import { LocalTerrainSource } from '../voxel/LocalTerrainSource.js';
import {
  computeAndPropagateLight, getSunlitAbove, computeVisibility, DEFAULT_CAVE_CONFIG,
  type CaveConfig,
} from '@worldify/shared';

const SEED = 12345;
const COLD_REPS = 5;
const WARM_COLS: ReadonlyArray<readonly [number, number]> = [[3, 0], [0, 3], [6, 6], [-4, 2]];

export interface GenBenchRow {
  label: string;
  chunks: number;
  constructMs: number;
  genColdMs: number;   // median cold bootstrap column (fresh source each rep)
  genWarmMs: number;   // median warm follow-up column
  ingest1Ms: number;   // first (top) chunk → first bound
  ingestAllMs: number; // whole column → all bootstrap bounds
}

const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
const r1 = (n: number) => Math.round(n * 10) / 10;
const yieldFrame = () => new Promise<void>((res) => setTimeout(res, 0));

async function benchConfig(label: string, caveConfig: CaveConfig | undefined): Promise<GenBenchRow> {
  const construct: number[] = [], genCold: number[] = [], ingest1: number[] = [], ingestAll: number[] = [];
  let chunks = 0;
  for (let rep = 0; rep < COLD_REPS; rep++) {
    let t = performance.now();
    const src = new LocalTerrainSource(SEED, caveConfig);
    construct.push(performance.now() - t);

    t = performance.now();
    const col = src.generateColumn(0, 0);            // COLD bootstrap column
    genCold.push(performance.now() - t);
    chunks = col.chunks.length;

    const top = col.chunks[col.chunks.length - 1];   // first ingested = top of column
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
    await yieldFrame(); // keep the page responsive between reps
  }

  // Warm follow-up columns on one source (caches warm) — the fill after the first.
  const warmSrc = new LocalTerrainSource(SEED, caveConfig);
  warmSrc.generateColumn(0, 0); // prime
  const genWarm: number[] = [];
  for (const [wx, wz] of WARM_COLS) {
    const t = performance.now();
    warmSrc.generateColumn(wx, wz);
    genWarm.push(performance.now() - t);
  }

  return {
    label, chunks,
    constructMs: r1(med(construct)),
    genColdMs: r1(med(genCold)),
    genWarmMs: r1(med(genWarm)),
    ingest1Ms: r1(med(ingest1)),
    ingestAllMs: r1(med(ingestAll)),
  };
}

/**
 * Run the generation bench. On a caves-capable build this measures BOTH the world's caves config and
 * a terrain-only config, to isolate the cave cost on THIS device. Progress rows are streamed via the
 * optional callback.
 */
export async function runGenBench(onRow?: (row: GenBenchRow) => void): Promise<GenBenchRow[]> {
  const rows: GenBenchRow[] = [];
  const configs: Array<[string, CaveConfig | undefined]> = [
    ['caves', DEFAULT_CAVE_CONFIG],
    ['terrain-only', { ...DEFAULT_CAVE_CONFIG, wormsEnabled: false, cavernsEnabled: false }],
  ];
  for (const [label, cfg] of configs) {
    const row = await benchConfig(label, cfg);
    rows.push(row);
    onRow?.(row);
    await yieldFrame();
  }
  return rows;
}

/** Device context to log alongside the numbers. */
export function deviceInfo(): string {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 0;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return `cores=${cores} | ${ua}`;
}
