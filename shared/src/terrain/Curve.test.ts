import { describe, it, expect } from 'vitest';
import { Curve } from './Curve.js';

describe('Curve (monotone cubic)', () => {
  it('passes through its control points', () => {
    const c = new Curve([{ x: 0, y: -50 }, { x: 0.5, y: 10 }, { x: 1, y: 300 }]);
    expect(c.eval(0)).toBeCloseTo(-50, 6);
    expect(c.eval(0.5)).toBeCloseTo(10, 6);
    expect(c.eval(1)).toBeCloseTo(300, 6);
  });

  it('clamps outside the domain', () => {
    const c = new Curve([{ x: 0.2, y: 5 }, { x: 0.8, y: 9 }]);
    expect(c.eval(-1)).toBeCloseTo(5, 6);
    expect(c.eval(2)).toBeCloseTo(9, 6);
  });

  it('is monotone non-decreasing for monotone data (no overshoot)', () => {
    const c = new Curve([{ x: 0, y: 0 }, { x: 0.3, y: 2 }, { x: 0.35, y: 40 }, { x: 1, y: 320 }]);
    let prev = -Infinity;
    for (let x = 0; x <= 1.0001; x += 0.01) {
      const y = c.eval(x);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = y;
    }
  });

  it('handles a flat segment without dipping', () => {
    const c = new Curve([{ x: 0, y: 5 }, { x: 0.5, y: 5 }, { x: 1, y: 20 }]);
    for (let x = 0; x <= 0.5; x += 0.05) expect(c.eval(x)).toBeCloseTo(5, 6);
  });

  it('tolerates unsorted / duplicate points', () => {
    const c = new Curve([{ x: 1, y: 10 }, { x: 0, y: 0 }, { x: 0, y: 999 }]);
    expect(c.eval(0)).toBeLessThan(10);
    expect(c.eval(1)).toBeCloseTo(10, 6);
  });
});
