/**
 * Tower building stamp (BUILDING_TOWER): a tall round tower with an internal spiral ramp,
 * a solid floor platform per level, arrow-slit windows, a doorway, and a conical roof.
 *
 * These assertions pin the properties that make the tower work in the world:
 *  - it is a hollow shell with carved openings (doorway / windows / interior),
 *  - it has an internal climbable structure (solid floor-material voxels spanning many
 *    heights above the ground floor = the spiral ramp + platforms),
 *  - its height varies 2-4 floors with the per-building seed,
 *  - its X/Z footprint is bounded and seed-independent (only the height changes with seed,
 *    which is what makes the seed-0 bounds used for chunk culling safe).
 */

import { describe, it, expect } from 'vitest';
import { getStamp, StampType, mat } from '../index.js';

const FLOOR_MATERIAL = mat('cobble2'); // floors + stair treads (see generateTowerSDF)
const VARIANT_R9 = 0;                   // variant 0 -> radius 9, so maxDim = 14

const tower = (seed: number, variant = VARIANT_R9) =>
  getStamp(StampType.BUILDING_TOWER, variant, 0, seed);

describe('BUILDING_TOWER stamp', () => {
  it('is a non-empty hollow shell with solid and carved-air voxels', () => {
    const { voxels } = tower(1);
    expect(voxels.length).toBeGreaterThan(0);

    const solid = voxels.filter((v) => v.weight > 0);
    const carvedAir = voxels.filter((v) => v.material === 0 && v.weight < 0);

    expect(solid.length).toBeGreaterThan(0);      // walls / floors / ramp / roof
    expect(carvedAir.length).toBeGreaterThan(0);  // doorway + windows + hollow interior
  });

  it('has an internal spiral ramp: solid floor-material voxels spanning many heights above the ground floor', () => {
    const { voxels } = tower(1);
    const rampLike = voxels.filter(
      (v) => v.weight > 0 && v.material === FLOOR_MATERIAL && v.y > 2,
    );
    // The ground floor alone would occupy y<=1; anything above is ramp / platforms.
    expect(rampLike.length).toBeGreaterThan(0);

    // A spiral ramp climbs continuously, so its treads touch many distinct heights
    // (at least a floor's worth), not just one or two platform slabs.
    const distinctHeights = new Set(rampLike.map((v) => v.y));
    expect(distinctHeights.size).toBeGreaterThanOrEqual(11);
  });

  it('varies 2-4 floors tall with the seed', () => {
    const heights = new Set<number>();
    for (let seed = 0; seed < 40; seed++) {
      const maxY = tower(seed).voxels.reduce((m, v) => Math.max(m, v.y), 0);
      heights.add(maxY);
      // radius 9 -> roof apex ~ floors*11 + 12; floors in {2,3,4} => ~34..56
      expect(maxY).toBeGreaterThanOrEqual(30);
      expect(maxY).toBeLessThanOrEqual(62);
    }
    // The random floor count (2-4) must actually produce different tower heights.
    expect(heights.size).toBeGreaterThanOrEqual(2);
  });

  it('has a bounded, seed-independent X/Z footprint (only height changes with seed)', () => {
    const a = tower(1).bounds;
    const b = tower(999).bounds;

    // Footprint fits inside the sampling box (radius 9 + margin 5, plus rounding slack).
    expect(a.minX).toBeGreaterThanOrEqual(-16);
    expect(a.maxX).toBeLessThanOrEqual(16);
    expect(a.minZ).toBeGreaterThanOrEqual(-16);
    expect(a.maxZ).toBeLessThanOrEqual(16);

    // Horizontal bounds do not depend on the seed (the seed only changes floor count).
    expect(a.minX).toBe(b.minX);
    expect(a.maxX).toBe(b.maxX);
    expect(a.minZ).toBe(b.minZ);
    expect(a.maxZ).toBe(b.maxZ);
  });
});
