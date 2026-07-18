/**
 * Parity test for the light-only relight path (P3).
 *
 * The light-only resample (ChunkGeometry.resampleLightFromGrid) rewrites a chunk's vertex light
 * WITHOUT re-running SurfaceNets, by re-reading each stored per-vertex cell index from a freshly
 * expanded grid via sampleCellLight(). For that to be correct, sampleCellLight() must reproduce
 * EXACTLY the light meshVoxelsSplit() bakes for the same grid + cell. This test locks that in:
 * mesh a synthetic grid, then for every vertex assert the re-sampled light equals the baked light.
 */

import { describe, it, expect } from 'vitest';
import {
  GRID_SIZE,
  MATERIAL_TYPE_LUT,
  MAT_TYPE_SOLID,
  BLOCK_LIGHT_SHIFT,
  packVoxel,
} from '@worldify/shared';
import { meshVoxelsSplit, sampleCellLight, unpackSkyLight, unpackBlockLight } from './SurfaceNet.js';

/** First material id classified as solid (so the grid has a real solid/air surface). */
function firstSolidMaterial(): number {
  for (let m = 0; m < MATERIAL_TYPE_LUT.length; m++) {
    if (MATERIAL_TYPE_LUT[m] === MAT_TYPE_SOLID) return m;
  }
  throw new Error('no solid material found');
}

/** Build a 34³ grid with a solid/air surface, spatially varied sky light, and a block-light blob. */
function buildGrid(): Uint32Array {
  const N = GRID_SIZE;
  const solid = firstSolidMaterial();
  const grid = new Uint32Array(N * N * N);
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const idx = z * N * N + y * N + x;
        const isSolid = y < 17;
        // Vary sky light across x/z on the air side so the test isn't a trivial constant.
        const sky = isSolid ? 0 : ((x * 3 + z * 5) % 32);
        grid[idx] = packVoxel(isSolid ? 0.4 : -0.4, isSolid ? solid : 0, sky);
        // A block-light blob on the air side near the middle (decreasing with distance).
        if (!isSolid) {
          const dx = x - 17, dz = z - 17, dy = y - 20;
          const d = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
          const bl = Math.max(0, 24 - d);
          if (bl > 0) grid[idx] |= bl << BLOCK_LIGHT_SHIFT;
        }
      }
    }
  }
  return grid;
}

describe('light-only resample parity', () => {
  it('sampleCellLight reproduces the light meshVoxelsSplit bakes, per vertex', () => {
    const grid = buildGrid();
    const out = meshVoxelsSplit({ dims: [GRID_SIZE, GRID_SIZE, GRID_SIZE], data: grid });

    let totalVerts = 0;
    let sawVariedSky = false;
    let sawBlock = false;

    for (const layer of [out.solid, out.transparent, out.liquid]) {
      const vc = layer.vertexCount;
      totalVerts += vc;
      for (let v = 0; v < vc; v++) {
        const packed = sampleCellLight(grid, layer.cellIndices[v]);
        // Bit-identical: resample must equal what the mesh stored for this vertex.
        expect(unpackSkyLight(packed)).toBeCloseTo(layer.lights[v], 6);
        expect(unpackBlockLight(packed)).toBeCloseTo(layer.blockLights[v], 6);
        if (layer.lights[v] > 0 && layer.lights[v] < 1) sawVariedSky = true;
        if (layer.blockLights[v] > 0) sawBlock = true;
      }
    }

    // Guard against a vacuous pass (e.g. empty mesh or all-zero light).
    expect(totalVerts).toBeGreaterThan(0);
    expect(sawVariedSky).toBe(true);
    expect(sawBlock).toBe(true);
  });
});
