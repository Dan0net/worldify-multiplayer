/**
 * Regression guard for the stamp-cache change (G4): caching building stamps (keyed by
 * type:variant:rotation:seed) instead of regenerating them per call must not change generated terrain.
 * Checksums a fixed spread of chunks with a fixed seed + default config (which places trees/rocks/
 * buildings) against a baseline captured before the change. A stamp is a pure function of its inputs
 * and callers treat it read-only, so caching is byte-identical — if this fails, that assumption broke.
 */
import { describe, it, expect } from 'vitest';
import { TerrainGenerator } from './TerrainGenerator.js';

function fnv1a(data: Uint32Array): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < data.length; i++) {
    h = (h ^ data[i]) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

const COORDS: Array<[number, number, number]> = [
  [0, 0, 0], [0, -1, 0], [0, -2, 0], [1, -1, 0], [0, -1, 1],
  [3, -2, -2], [-2, -3, 4], [5, -1, 5], [-4, -2, -4], [2, -4, 1],
];

function generateChecksum(): number {
  const gen = new TerrainGenerator({ seed: 12345 });
  let combined = 2166136261 >>> 0;
  for (const [cx, cy, cz] of COORDS) {
    combined = (combined ^ fnv1a(gen.generateChunk(cx, cy, cz))) >>> 0;
    combined = Math.imul(combined, 16777619) >>> 0;
  }
  return combined >>> 0;
}

// Baseline captured from the generator BEFORE the stamp-cache change.
const BASELINE = 1542389063; // re-baselined: worm sub-sample + cavern warp lattice

describe('stamp cache preserves generated terrain', () => {
  it('generates byte-identical voxel data for the fixed chunk spread', () => {
    expect(generateChecksum()).toBe(BASELINE);
  });
});
