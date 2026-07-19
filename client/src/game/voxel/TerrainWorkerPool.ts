/**
 * TerrainWorkerPool - dispatches local terrain generation to a pool of workers.
 *
 * Mirrors the mesh-worker pattern: requests are keyed by id and resolved via a
 * callback map. Work is distributed LEAST-BUSY across a core-scaled pool (not naive
 * round-robin), so an uneven column can't head-of-line-block one worker while others
 * idle. Async responses feed VoxelWorld's existing receive* methods, like the network path.
 */

import type { VoxelChunkData, MapTileResponse, SurfaceColumnResponse, CaveConfig, TerrainLayerConfig } from '@worldify/shared';
import type { TerrainWorkerResponse } from './terrainWorker.js';

/**
 * Number of terrain-generation workers, scaled to the machine. Generation is the streaming bottleneck,
 * so give it most cores while leaving headroom for the main thread + the (separate) mesh workers. Also
 * used to size VoxelWorld's in-flight request window so the two stay in sync (a worker is only useful if
 * the request layer keeps it fed). Capped so a many-core box doesn't spawn a worker per core — each owns
 * a TerrainGenerator + cave caches (memory), with diminishing returns past ~6.
 */
export function terrainWorkerCount(): number {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(3, Math.min(6, cores - 2));
}

export class TerrainWorkerPool {
  private readonly workers: Worker[] = [];
  /** Outstanding requests per worker, for least-busy selection. */
  private readonly inFlight: number[] = [];
  private readonly callbacks = new Map<number, (data: unknown) => void>();
  /** Which worker each in-flight id went to, so we can decrement its inFlight on response. */
  private readonly reqWorker = new Map<number, number>();
  private nextId = 0;

  constructor(seed: number, caveConfig?: CaveConfig, terrainConfig?: TerrainLayerConfig, poolSize?: number) {
    const size = poolSize ?? terrainWorkerCount();
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('./terrainWorker.ts', import.meta.url), { type: 'module' });
      worker.postMessage({ type: 'init', seed, caveConfig, terrainConfig });
      worker.onmessage = (e: MessageEvent<TerrainWorkerResponse>) => {
        const id = e.data.id;
        const wi = this.reqWorker.get(id);
        if (wi !== undefined) { this.inFlight[wi]--; this.reqWorker.delete(id); }
        const cb = this.callbacks.get(id);
        if (cb) {
          this.callbacks.delete(id);
          cb(e.data.data);
        }
      };
      this.workers.push(worker);
      this.inFlight.push(0);
    }
  }

  private post(msg: Record<string, unknown>, cb: (data: unknown) => void): void {
    const id = this.nextId++;
    this.callbacks.set(id, cb);

    // Least-busy: dispatch to the worker with the fewest outstanding requests. Workers process messages
    // serially, so this keeps queue depth even instead of piling onto one worker as round-robin could.
    let wi = 0;
    for (let i = 1; i < this.workers.length; i++) {
      if (this.inFlight[i] < this.inFlight[wi]) wi = i;
    }
    this.inFlight[wi]++;
    this.reqWorker.set(id, wi);
    this.workers[wi].postMessage({ ...msg, id });
  }

  requestChunk(cx: number, cy: number, cz: number, cb: (data: VoxelChunkData) => void): void {
    this.post({ type: 'chunk', cx, cy, cz }, cb as (data: unknown) => void);
  }

  requestTile(tx: number, tz: number, cb: (data: MapTileResponse) => void): void {
    this.post({ type: 'tile', tx, tz }, cb as (data: unknown) => void);
  }

  requestColumn(tx: number, tz: number, cb: (data: SurfaceColumnResponse) => void): void {
    this.post({ type: 'column', tx, tz }, cb as (data: unknown) => void);
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    this.inFlight.length = 0;
    this.callbacks.clear();
    this.reqWorker.clear();
  }
}
