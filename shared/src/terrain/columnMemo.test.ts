/**
 * Regression guard for the per-column memoisation (G2): memoising the 2D height field and the filtered
 * stamp placements per (cx,cz) — so a vertical stack of chunks doesn't recompute them per cy — must not
 * change generated terrain. Checksums a fixed spread of chunks against a baseline captured before the
 * change. Both memos are pure functions of position/config, so caching is byte-identical.
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

// Baseline captured from the generator BEFORE the per-column memoisation.
const BASELINE = 3427913447; // re-baselined: Tier2 — worm step 1.5/120seg + radius 2x stride + 1-octave pathway/terrain warp

describe('per-column memoisation preserves generated terrain', () => {
  it('generates byte-identical voxel data for the fixed chunk spread', () => {
    expect(generateChecksum()).toBe(BASELINE);
  });

  it('is order-independent: generating a column top-down vs bottom-up matches', () => {
    const a = new TerrainGenerator({ seed: 777 });
    const b = new TerrainGenerator({ seed: 777 });
    const down = [2, 1, 0, -1, -2].map((cy) => fnv1a(a.generateChunk(4, cy, 4)));
    const up = [-2, -1, 0, 1, 2].map((cy) => fnv1a(b.generateChunk(4, cy, 4)));
    // Same set of chunks regardless of generation order (the memo must not leak order dependence).
    expect(down.slice().sort()).toEqual(up.slice().sort());
  });
});
