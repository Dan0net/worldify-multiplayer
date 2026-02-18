/**
 * ChunkGeneratorPool - Worker thread pool for chunk generation
 *
 * Offloads CPU-intensive terrain generation to worker threads so the
 * main event loop stays responsive for game ticks and WebSocket I/O.
 *
 * Falls back to a main-thread async queue (with setImmediate yielding
 * between chunks) if workers cannot be created.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TerrainGenerator } from '@worldify/shared';

// ============== Types ==============

interface PendingTask {
  cx: number;
  cy: number;
  cz: number;
  resolve: (data: Uint16Array) => void;
  reject: (err: Error) => void;
}

// ============== Pool ==============

export class ChunkGeneratorPool {
  private workers: Worker[] = [];
  private readonly busyWorkers = new Set<Worker>();
  private readonly workerTasks = new Map<Worker, Map<number, PendingTask>>();
  private taskQueue: PendingTask[] = [];
  private nextId = 0;
  private readonly seed: number;

  // Fallback: main-thread generation with yielding
  private fallbackGenerator: TerrainGenerator | null = null;
  private fallbackQueue: PendingTask[] = [];
  private fallbackProcessing = false;

  constructor(workerCount: number, seed: number) {
    this.seed = seed;

    try {
      this.initWorkers(workerCount);
    } catch (err) {
      console.warn('[ChunkPool] Failed to create workers, using main-thread fallback:', err);
      this.fallbackGenerator = new TerrainGenerator({ seed });
    }
  }

  // ============== Worker Setup ==============

  private initWorkers(count: number): void {
    // Workers can't load .ts files directly (tsx only registers for the main thread).
    // Always use the compiled .js output in dist/workers/.
    const currentFile = fileURLToPath(import.meta.url);
    const currentDir = path.dirname(currentFile);
    const workerPath = currentFile.endsWith('.ts')
      // Dev mode (tsx): resolve from src/ to dist/
      ? path.join(currentDir.replace(/\/src\//, '/dist/'), 'chunkWorker.js')
      // Prod mode: already running from dist/
      : path.join(currentDir, 'chunkWorker.js');

    if (!fs.existsSync(workerPath)) {
      console.warn(`[ChunkPool] Worker JS not found at ${workerPath}. Run "npm run build" first. Using main-thread fallback.`);
      throw new Error('Worker JS not found');
    }

    for (let i = 0; i < count; i++) {
      const worker = new Worker(workerPath, {
        workerData: { seed: this.seed },
      });

      const tasks = new Map<number, PendingTask>();
      this.workerTasks.set(worker, tasks);

      worker.on('message', (msg: { type: string; id: number; buffer?: ArrayBuffer; message?: string }) => {
        const task = tasks.get(msg.id);
        if (!task) return;
        tasks.delete(msg.id);

        if (msg.type === 'result' && msg.buffer) {
          task.resolve(new Uint16Array(msg.buffer));
        } else if (msg.type === 'error') {
          task.reject(new Error(msg.message ?? 'Worker generation failed'));
        }

        this.busyWorkers.delete(worker);
        this.processQueue();
      });

      worker.on('error', (err) => {
        console.error('[ChunkPool] Worker error:', err);
        // Reject all pending tasks for this worker
        for (const task of tasks.values()) {
          task.reject(err);
        }
        tasks.clear();
        this.busyWorkers.delete(worker);

        // Remove dead worker
        this.workers = this.workers.filter(w => w !== worker);
        this.workerTasks.delete(worker);

        if (this.workers.length === 0) {
          console.warn('[ChunkPool] All workers dead, falling back to main thread');
          this.enableFallback();
        } else {
          this.processQueue();
        }
      });

      this.workers.push(worker);
    }

    console.log(`[ChunkPool] Created ${count} worker thread(s)`);
  }

  private enableFallback(): void {
    if (!this.fallbackGenerator) {
      this.fallbackGenerator = new TerrainGenerator({ seed: this.seed });
    }
    // Move queued worker tasks to fallback
    this.fallbackQueue.push(...this.taskQueue);
    this.taskQueue = [];
    this.processFallbackQueue();
  }

  // ============== Public API ==============

  async generateChunk(cx: number, cy: number, cz: number): Promise<Uint16Array> {
    return new Promise((resolve, reject) => {
      const task: PendingTask = { cx, cy, cz, resolve, reject };

      if (this.workers.length > 0) {
        this.taskQueue.push(task);
        this.processQueue();
      } else {
        this.fallbackQueue.push(task);
        this.processFallbackQueue();
      }
    });
  }

  /** Number of tasks waiting in the queue */
  get queueLength(): number {
    return this.taskQueue.length + this.fallbackQueue.length;
  }

  async shutdown(): Promise<void> {
    // Reject all queued tasks
    for (const task of [...this.taskQueue, ...this.fallbackQueue]) {
      task.reject(new Error('Pool shutting down'));
    }
    this.taskQueue = [];
    this.fallbackQueue = [];

    // Terminate workers
    await Promise.all(this.workers.map(w => w.terminate()));
    this.workers = [];
    this.workerTasks.clear();
    this.busyWorkers.clear();
  }

  // ============== Worker Dispatch ==============

  private processQueue(): void {
    while (this.taskQueue.length > 0) {
      const freeWorker = this.workers.find(w => !this.busyWorkers.has(w));
      if (!freeWorker) break;

      const task = this.taskQueue.shift()!;
      const id = this.nextId++;

      this.busyWorkers.add(freeWorker);
      this.workerTasks.get(freeWorker)!.set(id, task);

      freeWorker.postMessage({
        type: 'generate',
        id,
        cx: task.cx,
        cy: task.cy,
        cz: task.cz,
      });
    }
  }

  // ============== Main-Thread Fallback ==============

  private async processFallbackQueue(): Promise<void> {
    if (this.fallbackProcessing || !this.fallbackGenerator) return;
    this.fallbackProcessing = true;

    while (this.fallbackQueue.length > 0) {
      // Yield to let event loop handle ticks and network I/O
      await new Promise<void>(r => setImmediate(r));

      const task = this.fallbackQueue.shift()!;
      try {
        const data = this.fallbackGenerator.generateChunk(task.cx, task.cy, task.cz);
        task.resolve(data);
      } catch (err) {
        task.reject(err as Error);
      }
    }

    this.fallbackProcessing = false;
  }
}
