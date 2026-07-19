/**
 * faceDonatesLight correctness + the output-preservation property it guards.
 *
 * VoxelWorld.ingestChunkData skips relighting a horizontal / above neighbour when the arriving
 * chunk donates no light across the shared face. This test locks in the invariant that makes that
 * skip safe: a neighbour chunk lit with a NON-donating chunk present on a face is byte-identical to
 * the same chunk lit with that face absent (null). It also confirms the complementary case — a
 * DONATING neighbour genuinely changes the result — so the gate can't be trivially always-false.
 */

import { describe, it, expect } from 'vitest';
import {
  CHUNK_SIZE,
  VOXELS_PER_CHUNK,
  packVoxel,
  computeAndPropagateLight,
  faceDonatesLight,
} from '../index.js';

const CS = CHUNK_SIZE;
const NO_NEIGHBORS: (Uint32Array | null)[] = [null, null, null, null, null, null];

function fill(weight: number, material: number): Uint32Array {
  const d = new Uint32Array(VOXELS_PER_CHUNK);
  for (let i = 0; i < VOXELS_PER_CHUNK; i++) d[i] = packVoxel(weight, material, 0);
  return d;
}
const airChunk = () => fill(-0.4, 0); // empty air
const rockChunk = () => fill(0.4, 1); // opaque solid

/** A fully sky-lit air chunk (all voxels reach LIGHT_MAX). */
function litAir(): Uint32Array {
  const d = airChunk();
  computeAndPropagateLight(d, null, NO_NEIGHBORS);
  return d;
}
/** A fully dark solid chunk (the sun column is stopped at the top). */
function darkRock(): Uint32Array {
  const d = rockChunk();
  computeAndPropagateLight(d, null, NO_NEIGHBORS);
  return d;
}

describe('faceDonatesLight', () => {
  it('reports a lit-air boundary as donating and a dark-rock boundary as not', () => {
    const lit = litAir();
    const dark = darkRock();
    for (let face = 0; face < 6; face++) {
      expect(faceDonatesLight(lit, face)).toBe(true);
      expect(faceDonatesLight(dark, face)).toBe(false);
    }
  });

  it('a non-donating neighbour is indistinguishable from an absent one (the skip is safe)', () => {
    // The arriving chunk sits on the neighbour's +X face; the neighbour reads its x=0 boundary,
    // which is the arriving chunk's -X face (index 1). A dark-rock arrival donates nothing there.
    const rock = darkRock();
    expect(faceDonatesLight(rock, 1 /* -X, toward the neighbour */)).toBe(false);

    // Neighbour starts dark-from-above (underground) so any injected border light would show up.
    const DARK_ABOVE = new Uint8Array(CS * CS); // all zero

    const withRock = airChunk();
    const withNull = airChunk();
    computeAndPropagateLight(withRock, DARK_ABOVE, [rock, null, null, null, null, null]);
    computeAndPropagateLight(withNull, DARK_ABOVE, NO_NEIGHBORS);

    expect(withRock).toEqual(withNull);
  });

  it('a donating neighbour DOES change a dark chunk (the gate is not vacuous)', () => {
    const lit = litAir();
    expect(faceDonatesLight(lit, 1 /* -X, toward the neighbour */)).toBe(true);

    const DARK_ABOVE = new Uint8Array(CS * CS);
    const withLit = airChunk();
    const withNull = airChunk();
    computeAndPropagateLight(withLit, DARK_ABOVE, [lit, null, null, null, null, null]);
    computeAndPropagateLight(withNull, DARK_ABOVE, NO_NEIGHBORS);

    expect(withLit).not.toEqual(withNull);
  });
});
