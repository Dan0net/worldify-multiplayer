/**
 * terrainWorker - Web Worker for off-thread local terrain generation.
 *
 * Owns a LocalTerrainSource (seeded via an `init` message) and answers
 * chunk / tile / surface-column requests off the main thread, so generation
 * bursts no longer hang the UI. Responses are structured-cloned back (the
 * source keeps its own cached buffers, so we intentionally do NOT transfer).
 */

import { LocalTerrainSource } from './LocalTerrainSource.js';
import type { VoxelChunkData, MapTileResponse, SurfaceColumnResponse, CaveConfig, TerrainLayerConfig } from '@worldify/shared';

type InitMessage = { type: 'init'; seed: number; caveConfig?: CaveConfig; terrainConfig?: TerrainLayerConfig };
type ChunkMessage = { type: 'chunk'; id: number; cx: number; cy: number; cz: number };
type TileMessage = { type: 'tile'; id: number; tx: number; tz: number };
type ColumnMessage = { type: 'column'; id: number; tx: number; tz: number };
export type TerrainWorkerRequest = InitMessage | ChunkMessage | TileMessage | ColumnMessage;

export type TerrainWorkerResponse =
  | { id: number; data: VoxelChunkData; genMs: number; kind: 'chunk' }
  | { id: number; data: MapTileResponse; genMs: number; kind: 'tile' }
  | { id: number; data: SurfaceColumnResponse; genMs: number; kind: 'column' };

let source: LocalTerrainSource | null = null;

self.onmessage = (e: MessageEvent<TerrainWorkerRequest>) => {
  const msg = e.data;

  if (msg.type === 'init') {
    source = new LocalTerrainSource(msg.seed, msg.caveConfig, msg.terrainConfig);
    return;
  }
  if (!source) return;

  let data: VoxelChunkData | MapTileResponse | SurfaceColumnResponse;
  // Pure generation time inside the worker (excludes the queue wait before this message ran and the
  // structured-clone transfer back). The pool differences it against the request→receive latency to
  // separate "worker busy generating" from "request queued behind other jobs" — see ChunkProfiler.
  const t0 = performance.now();
  switch (msg.type) {
    case 'chunk':
      data = source.generateChunk(msg.cx, msg.cy, msg.cz);
      break;
    case 'tile':
      data = source.generateTile(msg.tx, msg.tz);
      break;
    case 'column':
      data = source.generateColumn(msg.tx, msg.tz);
      break;
  }
  const genMs = performance.now() - t0;

  (self as unknown as Worker).postMessage({ id: msg.id, data, genMs, kind: msg.type } as TerrainWorkerResponse);
};
