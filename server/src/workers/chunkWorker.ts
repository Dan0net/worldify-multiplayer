/**
 * Worker thread for chunk terrain generation.
 * Offloads CPU-intensive noise generation from the main event loop.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { TerrainGenerator } from '@worldify/shared';

if (!parentPort) {
  throw new Error('chunkWorker must be run as a worker thread');
}

const generator = new TerrainGenerator({ seed: workerData.seed });

parentPort.on('message', (msg: { type: string; id: number; cx: number; cy: number; cz: number }) => {
  if (msg.type === 'generate') {
    try {
      const data = generator.generateChunk(msg.cx, msg.cy, msg.cz);
      // Transfer the underlying buffer (zero-copy move to main thread)
      const buffer = data.buffer as ArrayBuffer;
      parentPort!.postMessage(
        { type: 'result', id: msg.id, buffer },
        [buffer]
      );
    } catch (err) {
      parentPort!.postMessage({ type: 'error', id: msg.id, message: String(err) });
    }
  }
});
