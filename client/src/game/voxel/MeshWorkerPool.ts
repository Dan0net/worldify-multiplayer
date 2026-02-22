/**
 * MeshWorkerPool - Manages a pool of mesh workers with grid buffer recycling
 * 
 * Dispatches SurfaceNet + geometry expansion work to web workers.
 * Grid buffers (Uint16Array, 34³) are recycled via Transferable round-trips
 * to avoid per-chunk allocations.
 * 
 * Two queues: priority (build preview) and regular (chunk remesh).
 * Priority tasks are always drained first when a worker becomes free.
 * 
 * Batch dispatch supports atomic completion and proper cancellation
 * that removes queued tasks and discards in-flight results.
 */

import type { MeshWorkerResponse, MeshSlotData } from './meshWorker.js';
import { GRID_SIZE } from '@worldify/shared';

// Grid total voxel count: GRID_SIZE³
const GRID_LENGTH = GRID_SIZE * GRID_SIZE * GRID_SIZE;

interface Task {
  id: number;
  chunkKey: string;
  grid: Uint16Array;
  skipHighBoundary: [boolean, boolean, boolean];
}

/** Result delivered to caller */
export interface MeshResult {
  chunkKey: string;
  solid: MeshSlotData;
  transparent: MeshSlotData;
  liquid: MeshSlotData;
}

/** Callback for when a single mesh result is ready */
export type MeshResultCallback = (result: MeshResult) => void;

/**
 * Pool of mesh workers with grid buffer recycling.
 */
export class MeshWorkerPool {
  private workers: Worker[] = [];
  private busyWorkers = new Set<Worker>();
  private nextId = 0;

  /** Regular-priority tasks (chunk remesh) */
  private taskQueue: Task[] = [];

  /** High-priority tasks (build preview) — drained first */
  private priorityQueue: Task[] = [];

  /** Callbacks for pending results, keyed by request id */
  private pendingCallbacks = new Map<number, (resp: MeshWorkerResponse) => void>();

  /** Pool of reusable grid buffers (returned by workers after each job) */
  private gridPool: Uint16Array[] = [];

  /** Track which chunk keys are in-flight (prevent duplicate dispatch) */
  private inFlight = new Set<string>();

  /** Chunk keys currently owned by a preview batch (regular remesh should skip) */
  private _previewChunks = new Set<string>();

  constructor(poolSize: number = 2) {
    for (let i = 0; i < poolSize; i++) {
      const worker = new Worker(
        new URL('./meshWorker.ts', import.meta.url),
        { type: 'module' }
      );
      worker.onmessage = (e: MessageEvent<MeshWorkerResponse>) => {
        this.handleResponse(worker, e.data);
      };
      this.workers.push(worker);
    }

    // Pre-allocate grid buffers (one per worker + a few spare)
    for (let i = 0; i < poolSize + 2; i++) {
      this.gridPool.push(new Uint16Array(GRID_LENGTH));
    }
  }

  /**
   * Take a grid buffer from the pool (or allocate if empty).
   * Caller fills this, then passes to dispatch().
   */
  takeGrid(): Uint16Array {
    return this.gridPool.pop() ?? new Uint16Array(GRID_LENGTH);
  }

  /**
   * Check if a chunk key is currently being meshed by a worker.
   */
  isInFlight(chunkKey: string): boolean {
    return this.inFlight.has(chunkKey);
  }

  /**
   * Check if a chunk key is owned by the active preview batch.
   * VoxelWorld.processRemeshQueue should skip these.
   */
  isPreviewChunk(chunkKey: string): boolean {
    return this._previewChunks.has(chunkKey);
  }

  /**
   * Dispatch a single chunk for meshing (regular priority).
   * The grid buffer is transferred to the worker (zero-copy) and will be
   * recycled when the result returns.
   */
  dispatch(
    chunkKey: string,
    grid: Uint16Array,
    skipHighBoundary: [boolean, boolean, boolean],
    callback: MeshResultCallback,
  ): void {
    const id = this.nextId++;
    this.inFlight.add(chunkKey);

    this.pendingCallbacks.set(id, (resp) => {
      this.inFlight.delete(chunkKey);
      callback({
        chunkKey: resp.chunkKey,
        solid: resp.solid,
        transparent: resp.transparent,
        liquid: resp.liquid,
      });
    });

    const task: Task = { id, chunkKey, grid, skipHighBoundary };
    const freeWorker = this.getFreeWorker();

    if (freeWorker) {
      this.postToWorker(freeWorker, task);
    } else {
      this.taskQueue.push(task);
    }
  }

  /**
   * Dispatch multiple chunks as a priority batch. Callback fires only when ALL complete.
   * Priority tasks are drained before regular tasks whenever a worker becomes free.
   * 
   * Returns a cancel function that:
   * - Removes queued tasks (recycles their grids)
   * - Discards results for tasks already on workers
   * - Clears preview chunk tracking
   */
  dispatchBatch(
    items: Array<{
      chunkKey: string;
      grid: Uint16Array;
      skipHighBoundary: [boolean, boolean, boolean];
    }>,
    callback: (results: MeshResult[]) => void,
  ): () => void {
    const results: MeshResult[] = [];
    let remaining = items.length;
    let cancelled = false;
    const batchIds = new Set<number>();

    if (remaining === 0) {
      callback([]);
      return () => {};
    }

    // Track preview chunk keys
    for (const item of items) {
      this._previewChunks.add(item.chunkKey);
    }

    const onSingle = (result: MeshResult) => {
      if (cancelled) return;
      results.push(result);
      remaining--;
      if (remaining === 0) {
        // Clear preview tracking on completion
        for (const item of items) {
          this._previewChunks.delete(item.chunkKey);
        }
        callback(results);
      }
    };

    // Dispatch each item at priority level
    for (const item of items) {
      const id = this.nextId++;
      this.inFlight.add(item.chunkKey);
      batchIds.add(id);

      this.pendingCallbacks.set(id, (resp) => {
        this.inFlight.delete(item.chunkKey);
        onSingle({
          chunkKey: resp.chunkKey,
          solid: resp.solid,
          transparent: resp.transparent,
          liquid: resp.liquid,
        });
      });

      const task: Task = { id, chunkKey: item.chunkKey, grid: item.grid, skipHighBoundary: item.skipHighBoundary };
      const freeWorker = this.getFreeWorker();

      if (freeWorker) {
        this.postToWorker(freeWorker, task);
      } else {
        // Priority queue — drained before regular taskQueue
        this.priorityQueue.push(task);
      }
    }

    // Cancel function: properly clean up queued + in-flight tasks
    return () => {
      cancelled = true;

      // Clear preview tracking
      for (const item of items) {
        this._previewChunks.delete(item.chunkKey);
      }

      // Remove queued tasks, recycle grids
      this.priorityQueue = this.priorityQueue.filter(t => {
        if (batchIds.has(t.id)) {
          this.gridPool.push(t.grid);
          this.pendingCallbacks.delete(t.id);
          this.inFlight.delete(t.chunkKey);
          return false;
        }
        return true;
      });

      // For tasks already on workers: replace callbacks with no-ops that still clean up
      for (const id of batchIds) {
        if (this.pendingCallbacks.has(id)) {
          this.pendingCallbacks.set(id, (resp) => {
            // Just clean up inFlight tracking, discard result
            this.inFlight.delete(resp.chunkKey);
          });
        }
      }
    };
  }

  /**
   * Cancel any in-flight work for a specific chunk key.
   * The worker still finishes, but the callback is silently replaced with a no-op.
   */
  cancelChunk(chunkKey: string): void {
    this.inFlight.delete(chunkKey);
    // Remove from both queues if not yet dispatched
    const filterQueue = (queue: Task[]): Task[] =>
      queue.filter(t => {
        if (t.chunkKey === chunkKey) {
          this.gridPool.push(t.grid);
          this.pendingCallbacks.delete(t.id);
          return false;
        }
        return true;
      });
    this.taskQueue = filterQueue(this.taskQueue);
    this.priorityQueue = filterQueue(this.priorityQueue);
  }

  /** Handle a response from a worker */
  private handleResponse(worker: Worker, resp: MeshWorkerResponse): void {
    this.busyWorkers.delete(worker);

    // Recycle the grid buffer
    this.gridPool.push(resp.grid);

    // Invoke callback
    const cb = this.pendingCallbacks.get(resp.id);
    this.pendingCallbacks.delete(resp.id);
    if (cb) {
      cb(resp);
    }

    // Process next queued task (priority first)
    this.drainQueue();
  }

  /** Try to dispatch queued tasks to free workers. Priority queue drained first. */
  private drainQueue(): void {
    while (this.priorityQueue.length > 0 || this.taskQueue.length > 0) {
      const freeWorker = this.getFreeWorker();
      if (!freeWorker) break;
      // Priority first
      const task = this.priorityQueue.length > 0
        ? this.priorityQueue.shift()!
        : this.taskQueue.shift()!;
      this.postToWorker(freeWorker, task);
    }
  }

  /** Find a worker that isn't busy */
  private getFreeWorker(): Worker | undefined {
    return this.workers.find(w => !this.busyWorkers.has(w));
  }

  /** Post a task to a worker, transferring the grid buffer */
  private postToWorker(worker: Worker, task: Task): void {
    this.busyWorkers.add(worker);
    worker.postMessage(
      { id: task.id, chunkKey: task.chunkKey, grid: task.grid, skipHighBoundary: task.skipHighBoundary },
      [task.grid.buffer],
    );
  }

  /** Terminate all workers */
  dispose(): void {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.busyWorkers.clear();
    this.pendingCallbacks.clear();
    this.taskQueue = [];
    this.priorityQueue = [];
    this.gridPool = [];
    this.inFlight.clear();
    this._previewChunks.clear();
  }
}
