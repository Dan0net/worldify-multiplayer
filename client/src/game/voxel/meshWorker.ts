/**
 * meshWorker - Web Worker for off-thread voxel mesh generation
 * 
 * Receives an expanded 34³ voxel grid (Uint16Array), runs SurfaceNet + geometry
 * expansion, returns raw typed arrays. The grid buffer is returned for recycling.
 * All typed arrays are transferred (zero-copy).
 */

import { meshVoxelsSplit, type SurfaceNetInput, type SurfaceNetOutput } from './SurfaceNet.js';
import { expandGeometry, type ExpandedMeshData } from './MeshGeometry.js';
import { GRID_SIZE } from '@worldify/shared';

/** Message from main thread → worker */
export interface MeshWorkerRequest {
  id: number;
  chunkKey: string;
  grid: Uint16Array;
  skipHighBoundary: [boolean, boolean, boolean];
}

/** Per-mesh-type result (or null if empty) */
export type MeshSlotData = ExpandedMeshData | null;

/** Message from worker → main thread */
export interface MeshWorkerResponse {
  id: number;
  chunkKey: string;
  grid: Uint16Array;  // returned for recycling
  solid: MeshSlotData;
  transparent: MeshSlotData;
  liquid: MeshSlotData;
}

function processMeshType(output: SurfaceNetOutput): MeshSlotData {
  return expandGeometry(output);
}

self.onmessage = (e: MessageEvent<MeshWorkerRequest>) => {
  const { id, chunkKey, grid, skipHighBoundary } = e.data;

  // Run SurfaceNet on the expanded grid
  const input: SurfaceNetInput = {
    dims: [GRID_SIZE, GRID_SIZE, GRID_SIZE],
    data: grid,
    skipHighBoundary,
  };
  const splitOutput = meshVoxelsSplit(input);

  // Expand indexed geometry to per-face vertices
  const solid = processMeshType(splitOutput.solid);
  const transparent = processMeshType(splitOutput.transparent);
  const liquid = processMeshType(splitOutput.liquid);

  const response: MeshWorkerResponse = { id, chunkKey, grid, solid, transparent, liquid };

  // Collect all transferable buffers (zero-copy back to main thread)
  const transferables: Transferable[] = [grid.buffer as ArrayBuffer];
  for (const slot of [solid, transparent, liquid]) {
    if (slot) {
      transferables.push(
        slot.positions.buffer as ArrayBuffer,
        slot.normals.buffer as ArrayBuffer,
        slot.materialIds.buffer as ArrayBuffer,
        slot.materialWeights.buffer as ArrayBuffer,
        slot.lightLevels.buffer as ArrayBuffer,
        slot.indices.buffer as ArrayBuffer,
      );
    }
  }

  (self as unknown as Worker).postMessage(response, transferables);
};
