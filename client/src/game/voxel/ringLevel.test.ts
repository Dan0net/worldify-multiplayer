import { describe, it, expect } from 'vitest';
import { CHUNK_WORLD_SIZE, MAX_ZOOM_LEVEL, VISIBILITY_RADIUS } from '@worldify/shared';
import { ringLevel, ringOuterRadius } from './ringLevel.js';

const R = VISIBILITY_RADIUS * CHUNK_WORLD_SIZE; // band unit (m); band L outer radius = R·2^L

describe('ringLevel — base-independent doubling bands (Phase B rings)', () => {
  it('returns the base level at the centre (inside the base disk)', () => {
    for (let base = 0; base <= MAX_ZOOM_LEVEL; base++) {
      expect(ringLevel(0, base)).toBe(base);
    }
  });

  it('never returns a level finer than base', () => {
    for (let d = 0; d < 10_000; d += 137) {
      expect(ringLevel(d, 2)).toBeGreaterThanOrEqual(2);
    }
  });

  it('is monotonically non-decreasing with distance', () => {
    let prev = ringLevel(0, 0);
    for (let d = 0; d <= 8000; d += 7) {
      const lvl = ringLevel(d, 0);
      expect(lvl).toBeGreaterThanOrEqual(prev);
      prev = lvl;
    }
  });

  it('clamps to MAX_ZOOM_LEVEL for far distances', () => {
    expect(ringLevel(1e9, 0)).toBe(MAX_ZOOM_LEVEL);
    expect(ringLevel(1e9, 4)).toBe(MAX_ZOOM_LEVEL);
  });

  it('bands double, anchored to the visibility radius (base disk edge = R·2^base)', () => {
    expect(ringOuterRadius(0)).toBe(R);       // 88
    expect(ringOuterRadius(1)).toBe(R * 2);   // 176
    expect(ringOuterRadius(2)).toBe(R * 4);   // 352
    // Boundary is half-open: the outer radius belongs to the next (coarser) band.
    expect(ringLevel(R - 0.001, 0)).toBe(0);
    expect(ringLevel(R, 0)).toBe(1);
    expect(ringLevel(R * 2 - 0.001, 0)).toBe(1);
    expect(ringLevel(R * 2, 0)).toBe(2);
  });

  it('is base-independent above the base disk (rings keep their level as base changes)', () => {
    // A point at ~1.5·R sits in band 1. Its level is 1 for any base ≤ 1, and only rises once the base
    // floor exceeds the band — this stability is what lets outer rings persist across a zoom.
    const d = R * 1.5;
    expect(ringLevel(d, 0)).toBe(1);
    expect(ringLevel(d, 1)).toBe(1);
    expect(ringLevel(d, 2)).toBe(2); // floored to base
    // A point at ~5·R sits in band 3 (4R..8R); stable for base 0..3.
    const far = R * 5;
    expect(ringLevel(far, 0)).toBe(3);
    expect(ringLevel(far, 3)).toBe(3);
    expect(ringLevel(far, 4)).toBe(4); // floored to base
  });

  it('handles out-of-range base by clamping', () => {
    expect(ringLevel(0, -3)).toBe(0);
    expect(ringLevel(0, 99)).toBe(MAX_ZOOM_LEVEL);
  });
});
