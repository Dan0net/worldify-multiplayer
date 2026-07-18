/**
 * Tower building stamp (BUILDING_TOWER): a tall round tower whose internal spiral ramp hugs
 * the wall, with a central floor landing per level (inside the ramp band), arrow-slit windows,
 * a doorway, and a conical roof.
 *
 * These assertions pin the properties that make the tower work in the world:
 *  - it is a hollow shell with carved openings (doorway / windows / interior),
 *  - it has an internal climbable structure (floor-material voxels spanning many heights),
 *  - the ramp and central landings both have real walkable headroom (regression guard: an
 *    earlier full-disc floor capped the ramp so the player could not fit),
 *  - its height varies 2-4 floors with the per-building seed,
 *  - its X/Z footprint is bounded and seed-independent (only the height changes with seed,
 *    which is what makes the seed-0 bounds used for chunk culling safe).
 */

import { describe, it, expect } from 'vitest';
import { getStamp, StampType, mat } from '../index.js';

const FLOOR_MATERIAL = mat('cobble2'); // floors + ramp + landings (see generateTowerSDF)
const VARIANT_R12 = 0;                  // variant 0 -> radius 12, so maxDim = 17

// Geometry mirrors generateTowerSDF for variant 0.
const RADIUS = 12, WALL_THICKNESS = 2, STAIR_WIDTH = 5;
const INTERIOR_R = RADIUS - WALL_THICKNESS;   // 10
const INNER_EDGE = INTERIOR_R - STAIR_WIDTH;  // 5
const PLAYER_VOXELS = 6.4;                    // 1.6 m / 0.25 m per voxel

const tower = (seed: number, variant = VARIANT_R12) =>
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

  it('has an internal spiral ramp: floor-material voxels spanning many heights above the ground floor', () => {
    const { voxels } = tower(1);
    const rampLike = voxels.filter(
      (v) => v.weight > 0 && v.material === FLOOR_MATERIAL && v.y > 2,
    );
    // The ground floor alone would occupy y<=1; anything above is ramp / landings.
    expect(rampLike.length).toBeGreaterThan(0);

    // A spiral ramp climbs continuously, so its treads touch many distinct heights
    // (at least a floor's worth), not just one or two landing slabs.
    const distinctHeights = new Set(rampLike.map((v) => v.y));
    expect(distinctHeights.size).toBeGreaterThanOrEqual(11);
  });

  it('gives the ramp and landings walkable headroom (regression: floors must not cap the ramp)', () => {
    const { voxels } = tower(13); // a 4-floor tower
    const solid = new Set<string>();
    const walkable = new Set<string>();
    for (const v of voxels) {
      if (v.weight <= 0) continue;
      const k = `${v.x},${v.y},${v.z}`;
      solid.add(k);
      if (v.material === FLOOR_MATERIAL) walkable.add(k);
    }

    const clearanceAbove = (x: number, y: number, z: number) => {
      let c = 0;
      for (let yy = y + 1; yy < y + 60; yy++) { if (solid.has(`${x},${yy},${z}`)) break; c++; }
      return c;
    };

    let rampMin = Infinity, centreMin = Infinity;
    for (const k of walkable) {
      const [x, y, z] = k.split(',').map(Number);
      if (y < 1) continue;                            // skip the ground slab
      if (solid.has(`${x},${y + 1},${z}`)) continue;  // only top (walkable) surfaces
      const r = Math.hypot(x, z);
      const clear = clearanceAbove(x, y, z);
      // Stay inside the wall's inner face on the ramp band so window sills don't count.
      if (r >= INNER_EDGE + 0.5 && r <= INTERIOR_R - 1.0) rampMin = Math.min(rampMin, clear);
      else if (r >= 1 && r <= INNER_EDGE - 0.5) centreMin = Math.min(centreMin, clear);
    }

    // Both zones must clear the player capsule with margin. Pre-rework this was ~3-4 voxels.
    expect(rampMin).toBeGreaterThan(PLAYER_VOXELS);
    expect(centreMin).toBeGreaterThan(PLAYER_VOXELS);
  });

  it('varies 2-4 floors tall with the seed', () => {
    const heights = new Set<number>();
    for (let seed = 0; seed < 40; seed++) {
      const maxY = tower(seed).voxels.reduce((m, v) => Math.max(m, v.y), 0);
      heights.add(maxY);
      // radius 12 -> roof apex ~ floors*12 + 15; floors in {2,3,4} => ~39..63
      expect(maxY).toBeGreaterThanOrEqual(34);
      expect(maxY).toBeLessThanOrEqual(68);
    }
    // The random floor count (2-4) must actually produce different tower heights.
    expect(heights.size).toBeGreaterThanOrEqual(2);
  });

  it('has a bounded, seed-independent X/Z footprint (only height changes with seed)', () => {
    const a = tower(1).bounds;
    const b = tower(999).bounds;

    // Footprint fits inside the sampling box (radius 12 + margin 5, plus rounding slack).
    expect(a.minX).toBeGreaterThanOrEqual(-20);
    expect(a.maxX).toBeLessThanOrEqual(20);
    expect(a.minZ).toBeGreaterThanOrEqual(-20);
    expect(a.maxZ).toBeLessThanOrEqual(20);

    // Horizontal bounds do not depend on the seed (the seed only changes floor count).
    expect(a.minX).toBe(b.minX);
    expect(a.maxX).toBe(b.maxX);
    expect(a.minZ).toBe(b.minZ);
    expect(a.maxZ).toBe(b.maxZ);
  });
});
