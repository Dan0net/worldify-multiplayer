/**
 * TerrainWorkerPool - dispatches local terrain generation to a pool of workers.
 *
 * Mirrors the mesh-worker pattern: requests are keyed by id and resolved via a
 * callback map; work is round-robined across a few workers so generation runs
 * in parallel off the main thread. Async responses feed VoxelWorld's existing
 * receive* methods, exactly like the network path.
 */

import type { VoxelChunkData, MapTileResponse, SurfaceColumnResponse } from '@worldify/shared';
import type { TerrainWorkerResponse } from './terrainWorker.js';

export class TerrainWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly callbacks = new Map<number, (data: unknown) => void>();
  private nextId = 0;
  private nextWorker = 0;

  constructor(seed: number, poolSize = 3) {
    for (let i = 0; i < poolSize; i++) {
      const worker = new Worker(new URL('./terrainWorker.ts', import.meta.url), { type: 'module' });
      worker.postMessage({ type: 'init', seed });
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

  private post(msg: Record<string, unknown>, cb: (data: unknown) => void): void {
    const id = this.nextId++;
    this.callbacks.set(id, cb);
    const worker = this.workers[this.nextWorker];
    this.nextWorker = (this.nextWorker + 1) % this.workers.length;
    worker.postMessage({ ...msg, id });
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
    this.callbacks.clear();
  }
}
