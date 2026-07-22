/**
 * terrainWorker - Web Worker for off-thread local terrain generation.
 *
 * Owns a LocalTerrainSource (seeded via an `init` message) and answers
 * chunk / tile / surface-column requests off the main thread, so generation
 * bursts no longer hang the UI. The typed-array payloads are TRANSFERRED back
 * (zero-copy on the main thread) — but the source caches its buffers, so we
 * transfer COPIES (slice) rather than the cached originals: the ~128 KB
 * per-chunk copy then happens here on the worker instead of as a
 * structured-clone deserialise on the main thread during streaming bursts.
 */

import { LocalTerrainSource } from './LocalTerrainSource.js';
import type { VoxelChunkData, MapTileResponse, SurfaceColumnResponse, CaveConfig, TerrainLayerConfig } from '@worldify/shared';

type InitMessage = { type: 'init'; seed: number; caveConfig?: CaveConfig; terrainConfig?: TerrainLayerConfig };
type ChunkMessage = { type: 'chunk'; id: number; cx: number; cy: number; cz: number; level?: number };
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
      data = source.generateChunk(msg.cx, msg.cy, msg.cz, msg.level ?? 0);
      break;
    case 'tile':
      data = source.generateTile(msg.tx, msg.tz);
      break;
    case 'column':
      data = source.generateColumn(msg.tx, msg.tz);
      break;
  }

  // Transfer copies of the typed-array payloads (never the source's cached originals, which would be
  // neutered). Copying here moves the per-chunk buffer copy off the main thread; the transfer then
  // hands the copy over zero-copy.
  const transfer: ArrayBuffer[] = [];
  const copyForTransfer = (obj: Record<string, unknown>, key: string): void => {
    const v = obj[key];
    if (ArrayBuffer.isView(v)) {
      const copy = (v as Uint32Array).slice();
      obj[key] = copy;
      transfer.push(copy.buffer);
    }
  };

  const d = data as unknown as Record<string, unknown>;
  copyForTransfer(d, 'voxelData');                      // chunk payload
  copyForTransfer(d, 'heights');                        // tile / column payload
  copyForTransfer(d, 'materials');
  if (Array.isArray(d.chunks)) {                        // column payload: per-chunk voxel data
    for (const c of d.chunks as Array<Record<string, unknown>>) copyForTransfer(c, 'voxelData');
  }

  (self as unknown as Worker).postMessage({ id: msg.id, data } as TerrainWorkerResponse, transfer);
};
