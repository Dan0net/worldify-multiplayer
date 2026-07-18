/**
 * Margin-expansion test (P8 — corner/edge margin sources).
 *
 * A chunk's mesh reads its high-side (+X/+Y/+Z) margin from SEVEN positive neighbours: 3 faces, 3
 * edges, 1 corner. When one is absent the margin is extrapolated from this chunk's own edge, which
 * puts the shared boundary vertices in the wrong place (a seam gap). This locks in that the corner
 * and edge neighbours genuinely feed the margin — so a chunk meshed before those neighbours arrived
 * must re-mesh once they do (exactly what the ingest/queueNeighborRemesh negative-7 re-trigger fixes).
 */

import { describe, it, expect } from 'vitest';
import { GRID_SIZE, CHUNK_SIZE, packVoxel, voxelIndex, chunkKey, getMaterial } from '@worldify/shared';
import { expandChunkToGrid } from './ChunkMesher.js';
import { Chunk } from './Chunk.js';

const CS = CHUNK_SIZE;
const MARK = packVoxel(0.5, 5, 0); // distinct solid marker (material 5)
const AIR = packVoxel(-0.4, 0, 0); // material 0

/** Flat index into the 34³ expanded grid. */
function gi(x: number, y: number, z: number): number {
  return x + y * GRID_SIZE + z * GRID_SIZE * GRID_SIZE;
}

function chunkFilled(cx: number, cy: number, cz: number, fill: number): Chunk {
  const c = new Chunk(cx, cy, cz);
  c.data.fill(fill);
  return c;
}

describe('mesh margin expansion (P8)', () => {
  it('fills the +XYZ corner margin from the corner neighbour, extrapolating when absent', () => {
    const c = chunkFilled(0, 0, 0, AIR);
    const corner = chunkFilled(1, 1, 1, AIR); // +X+Y+Z corner neighbour
    corner.data[voxelIndex(0, 0, 0)] = MARK; // grid (32,32,32) reads this
    corner.data[voxelIndex(1, 1, 1)] = MARK; // grid (33,33,33) reads this

    const withCorner = new Uint32Array(GRID_SIZE ** 3);
    expandChunkToGrid(c, new Map([[chunkKey(0, 0, 0), c], [chunkKey(1, 1, 1), corner]]), withCorner);
    expect(getMaterial(withCorner[gi(CS, CS, CS)])).toBe(5);
    expect(getMaterial(withCorner[gi(CS + 1, CS + 1, CS + 1)])).toBe(5);

    const noCorner = new Uint32Array(GRID_SIZE ** 3);
    expandChunkToGrid(c, new Map([[chunkKey(0, 0, 0), c]]), noCorner);
    // Corner absent → extrapolated from this chunk's edge (air, material 0).
    expect(getMaterial(noCorner[gi(CS, CS, CS)])).toBe(0);
    // The corner source changes the mesh input, so a chunk meshed before it arrived must re-mesh.
    expect(withCorner[gi(CS, CS, CS)]).not.toBe(noCorner[gi(CS, CS, CS)]);
  });

  it('fills a +XY edge margin from the edge neighbour', () => {
    const c = chunkFilled(0, 0, 0, AIR);
    const edge = chunkFilled(1, 1, 0, AIR); // +X+Y edge neighbour
    edge.data[voxelIndex(0, 0, 5)] = MARK;  // grid (32,32,5) reads this

    const grid = new Uint32Array(GRID_SIZE ** 3);
    expandChunkToGrid(c, new Map([[chunkKey(0, 0, 0), c], [chunkKey(1, 1, 0), edge]]), grid);
    expect(getMaterial(grid[gi(CS, CS, 5)])).toBe(5);
  });
});
