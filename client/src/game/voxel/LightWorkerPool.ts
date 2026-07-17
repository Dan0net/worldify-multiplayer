/**
 * LightWorkerPool - a single web worker that relights a chunk region off the main thread.
 *
 * One worker (the region is a 3×3×3 around an edit — small, and one worker keeps ordering trivial).
 * Callers dispatch a region snapshot + targets and get the relit target arrays back. A job can be
 * cancelled (superseded): its result, if it still arrives, is dropped. Construction failure is
 * surfaced via `available` so callers can fall back to a synchronous relight.
 */

import type { LightChunk, LightWorkerRequest, LightWorkerResponse } from './lightWorker.js';
import type { RelightTarget } from '@worldify/shared';

export type { LightChunk } from './lightWorker.js';

/** Called with the relit target arrays when a job completes. */
export type LightResultCallback = (results: LightChunk[]) => void;

export class LightWorkerPool {
  private worker: Worker | null = null;
  private nextId = 0;
  private pending = new Map<number, LightResultCallback>();

  constructor() {
    try {
      this.worker = new Worker(new URL('./lightWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<LightWorkerResponse>) => {
        const cb = this.pending.get(e.data.id);
        this.pending.delete(e.data.id);
        if (cb) cb(e.data.results);
      };
    } catch {
      // Worker unavailable (e.g. headless/older env) — callers fall back to a synchronous relight.
      this.worker = null;
    }
  }

  /** True when the worker exists; false means callers must relight synchronously. */
  get available(): boolean {
    return this.worker !== null;
  }

  /**
   * Dispatch a region relight. The snapshot arrays are transferred (zero-copy) — the caller must
   * pass copies it no longer needs. Returns the job id (pass to cancel()).
   */
  dispatch(chunks: LightChunk[], targets: RelightTarget[], cb: LightResultCallback): number {
    const id = this.nextId++;
    this.pending.set(id, cb);
    const transfer = chunks.map((c) => c.data.buffer as ArrayBuffer);
    this.worker!.postMessage({ id, chunks, targets } as LightWorkerRequest, transfer);
    return id;
  }

  /** Drop a pending job's callback — if its result still arrives it is ignored. */
  cancel(id: number): void {
    this.pending.delete(id);
  }

  dispose(): void {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.pending.clear();
  }
}
