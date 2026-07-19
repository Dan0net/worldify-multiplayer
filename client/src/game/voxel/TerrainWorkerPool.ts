/**
 * TerrainWorkerPool - dispatches local terrain generation to a pool of workers.
 *
 * Mirrors the mesh-worker pattern: requests are keyed by id and resolved via a
 * callback map so generation runs in parallel off the main thread. Async
 * responses feed VoxelWorld's existing receive* methods, exactly like the
 * network path.
 *
 * Dispatch is by COLUMN AFFINITY rather than round-robin: every request that
 * touches a 2D column (cx,cz) — its tile/column bundle and each of its vertical
 * chunks — is routed to the same worker via a stable spatial hash. Each worker
 * keeps its own unshared `rawChunk` cache (LocalTerrainSource), so a tile
 * request's full-column generation populates that cache and the follow-up
 * per-chunk requests hit it instead of regenerating the whole stamp-inclusive
 * column on a different worker. This removes the column double-generation that
 * round-robin caused (tile generated a column on worker A, its chunks then
 * regenerated on workers B/C/… with cold caves + stamps).
 */

import type { VoxelChunkData, MapTileResponse, SurfaceColumnResponse, CaveConfig, TerrainLayerConfig } from '@worldify/shared';
import type { TerrainWorkerResponse } from './terrainWorker.js';

export class TerrainWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly callbacks = new Map<number, (data: unknown) => void>();
  private nextId = 0;

  constructor(seed: number, caveConfig?: CaveConfig, terrainConfig?: TerrainLayerConfig, poolSize = 3) {
    for (let i = 0; i < poolSize; i++) {
      const worker = new Worker(new URL('./terrainWorker.ts', import.meta.url), { type: 'module' });
      worker.postMessage({ type: 'init', seed, caveConfig, terrainConfig });
      worker.onmessage = (e: MessageEvent<TerrainWorkerResponse>) => {
        const cb = this.callbacks.get(e.data.id);
        if (cb) {
          this.callbacks.delete(e.data.id);
          cb(e.data.data);
        }
      };
      this.workers.push(worker);
    }
  }

  /**
   * Stable worker index for a 2D column (a,b). Same hash the terrain/cave caches
   * use elsewhere (Math.imul with the two large primes), reduced modulo the pool
   * size, so a column always maps to one worker for the lifetime of the pool.
   */
  private workerForColumn(a: number, b: number): number {
    const h = (Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663)) >>> 0;
    return h % this.workers.length;
  }

  private post(worker: Worker, msg: Record<string, unknown>, cb: (data: unknown) => void): void {
    const id = this.nextId++;
    this.callbacks.set(id, cb);
    worker.postMessage({ ...msg, id });
  }

  requestChunk(cx: number, cy: number, cz: number, cb: (data: VoxelChunkData) => void): void {
    const worker = this.workers[this.workerForColumn(cx, cz)];
    this.post(worker, { type: 'chunk', cx, cy, cz }, cb as (data: unknown) => void);
  }

  requestTile(tx: number, tz: number, cb: (data: MapTileResponse) => void): void {
    const worker = this.workers[this.workerForColumn(tx, tz)];
    this.post(worker, { type: 'tile', tx, tz }, cb as (data: unknown) => void);
  }

  requestColumn(tx: number, tz: number, cb: (data: SurfaceColumnResponse) => void): void {
    const worker = this.workers[this.workerForColumn(tx, tz)];
    this.post(worker, { type: 'column', tx, tz }, cb as (data: unknown) => void);
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    this.callbacks.clear();
  }
}
