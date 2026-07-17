/**
 * lightWorker - Web Worker for off-thread region relighting.
 *
 * Receives a snapshot of a chunk region (target chunks + their 1-ring face context, each a copied
 * Uint32Array) and the relight targets, runs the SHARED relightRegion() orchestration over it, and
 * transfers back only the mutated target arrays. Because it runs the exact same relightRegion() the
 * main thread uses, off-thread preview light is bit-identical to a synchronous relight (locked by
 * shared/voxel/regionRelight.test.ts).
 *
 * Region-send model: the snapshot arrays are copies, so transferring them into the worker (and the
 * results back) is zero-copy without disturbing the live/temp buffers on the main thread.
 */

import { relightRegion, chunkKey, type RelightTarget } from '@worldify/shared';

/** One chunk in the region snapshot. */
export interface LightChunk {
  key: string;
  data: Uint32Array;
}

/** Message from main thread → worker. */
export interface LightWorkerRequest {
  id: number;
  /** Target chunks + their face-neighbour context, keyed by chunkKey (copies — transferred in). */
  chunks: LightChunk[];
  /** Chunks to relight (top-down sky order preserved by the caller). */
  targets: RelightTarget[];
}

/** Message from worker → main thread. */
export interface LightWorkerResponse {
  id: number;
  /** Relit target arrays (transferred back). */
  results: LightChunk[];
}

self.onmessage = (e: MessageEvent<LightWorkerRequest>) => {
  const { id, chunks, targets } = e.data;

  const map = new Map<string, Uint32Array>();
  for (const c of chunks) map.set(c.key, c.data);
  const getData = (cx: number, cy: number, cz: number): Uint32Array | null =>
    map.get(chunkKey(cx, cy, cz)) ?? null;

  relightRegion(getData, targets);

  // Return only the relit target arrays (context chunks were read-only).
  const results: LightChunk[] = [];
  const transfer: ArrayBuffer[] = [];
  for (const t of targets) {
    const key = chunkKey(t.cx, t.cy, t.cz);
    const data = map.get(key);
    if (data) {
      results.push({ key, data });
      transfer.push(data.buffer as ArrayBuffer);
    }
  }

  (self as unknown as Worker).postMessage({ id, results } as LightWorkerResponse, transfer);
};
