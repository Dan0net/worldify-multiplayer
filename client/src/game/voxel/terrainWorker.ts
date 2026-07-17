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
  | { id: number; data: VoxelChunkData }
  | { id: number; data: MapTileResponse }
  | { id: number; data: SurfaceColumnResponse };

let source: LocalTerrainSource | null = null;

self.onmessage = (e: MessageEvent<TerrainWorkerRequest>) => {
  const msg = e.data;

  if (msg.type === 'init') {
    source = new LocalTerrainSource(msg.seed, msg.caveConfig, msg.terrainConfig);
    return;
  }
  if (!source) return;

  let data: VoxelChunkData | MapTileResponse | SurfaceColumnResponse;
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

  (self as unknown as Worker).postMessage({ id: msg.id, data } as TerrainWorkerResponse);
};
