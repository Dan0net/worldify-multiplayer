import { describe, it, expect } from 'vitest';
import { CHUNK_WORLD_SIZE, MAX_ZOOM_LEVEL, VISIBILITY_RADIUS } from '@worldify/shared';
import { ringLevel, ringOuterRadius, RING_WIDTH_CHUNKS } from './ringLevel.js';

/** Recompute the expected inner-ring radius from first principles (independent of the impl). */
const innerRadius = (base: number) => VISIBILITY_RADIUS * (CHUNK_WORLD_SIZE * (1 << base));

describe('ringLevel — distance→LOD schedule (Phase B rings)', () => {
  it('returns the base level at the centre (ring 0 is the finest)', () => {
    for (let base = 0; base <= MAX_ZOOM_LEVEL; base++) {
      expect(ringLevel(0, base)).toBe(base);
    }
  });

  it('never returns a level finer than base', () => {
    // At base 2, even distance 0 stays at 2 — there is no ring below the base.
    for (let d = 0; d < 10_000; d += 137) {
      expect(ringLevel(d, 2)).toBeGreaterThanOrEqual(2);
    }
  });

  it('is monotonically non-decreasing with distance', () => {
    let prev = ringLevel(0, 0);
    for (let d = 0; d <= 5000; d += 7) {
      const lvl = ringLevel(d, 0);
      expect(lvl).toBeGreaterThanOrEqual(prev);
      prev = lvl;
    }
  });

  it('clamps to MAX_ZOOM_LEVEL for far distances', () => {
    expect(ringLevel(1e9, 0)).toBe(MAX_ZOOM_LEVEL);
    expect(ringLevel(1e9, 4)).toBe(MAX_ZOOM_LEVEL);
  });

  it('places the base→base+1 boundary at the inner-ring radius (half-open)', () => {
    const r = innerRadius(0); // 88 m
    expect(ringOuterRadius(0, 0)).toBe(r);
    expect(ringLevel(r - 0.001, 0)).toBe(0);
    expect(ringLevel(r, 0)).toBe(1); // boundary belongs to the OUTER (coarser) ring
  });

  it('accumulates each coarse ring at RING_WIDTH_CHUNKS of its own level', () => {
    // base 0: inner=88, then +6·8·2^L per ring.
    expect(ringOuterRadius(1, 0)).toBe(88 + RING_WIDTH_CHUNKS * 8 * 2);   // 184
    expect(ringOuterRadius(2, 0)).toBe(184 + RING_WIDTH_CHUNKS * 8 * 4);  // 376
    expect(ringLevel(90, 0)).toBe(1);
    expect(ringLevel(184, 0)).toBe(2);
    expect(ringLevel(375, 0)).toBe(2);
    expect(ringLevel(376, 0)).toBe(3);
  });

  it('scales the whole schedule with base (radii are true-world metres)', () => {
    // base 2: inner ring is 4× the base-0 inner radius (level-2 chunks are 4× wider).
    expect(ringOuterRadius(2, 2)).toBe(innerRadius(2)); // 352
    expect(ringLevel(innerRadius(2) - 1, 2)).toBe(2);
    expect(ringLevel(innerRadius(2), 2)).toBe(3);
  });

  it('handles out-of-range base by clamping', () => {
    expect(ringLevel(0, -3)).toBe(0);
    expect(ringLevel(0, 99)).toBe(MAX_ZOOM_LEVEL);
  });
});
