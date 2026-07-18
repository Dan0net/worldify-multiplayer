/**
 * Tower building stamp (BUILDING_TOWER): a tall round tower whose internal spiral ramp hugs
 * the wall, with a central floor landing per level, a complete top-floor deck, 4 windows per
 * floor, a doorway, and — by variant — either a conical roof (variants 0-1) or a crenellated
 * open terrace (battlement, variants 2-3).
 *
 * These assertions pin the properties that make the tower work in the world:
 *  - it is a hollow shell with carved openings (doorway / windows / interior),
 *  - the ramp and landings have real walkable headroom in BOTH variants (regression guard:
 *    an earlier full-disc floor, and later a mis-computed parapet, each capped the ramp),
 *  - every floor has 4 windows; the top floor is a complete deck (not just a central disc),
 *  - the battlement variant drops the roof and adds a crenellated parapet,
 *  - height varies 2-4 floors with the seed; the X/Z footprint is bounded and seed-independent.
 */

import { describe, it, expect } from 'vitest';
import { getStamp, StampType, mat } from '../index.js';

const FLOOR_MATERIAL = mat('cobble2'); // floors + ramp + landings + deck (see generateTowerSDF)

// Geometry mirrors generateTowerSDF (radius 12 for even variants, floorHeight 12, stairWidth 5).
const RADIUS = 12, INTERIOR_R = RADIUS - 2, INNER_EDGE = INTERIOR_R - 5;
const FLOOR_HEIGHT = 12;
const PLAYER_VOXELS = 6.4; // 1.6 m / 0.25 m per voxel
const TWO_PI = Math.PI * 2;

const tower = (seed: number, variant = 0) => getStamp(StampType.BUILDING_TOWER, variant, 0, seed);
const solidSet = (voxels: Array<{ x: number; y: number; z: number; weight: number }>) => {
  const s = new Set<string>();
  for (const v of voxels) if (v.weight > 0) s.add(`${v.x},${v.y},${v.z}`);
  return s;
};
const maxYOf = (voxels: Array<{ y: number; weight: number }>) =>
  voxels.reduce((m, v) => (v.weight > 0 ? Math.max(m, v.y) : m), 0);

// Number of angular gaps (openings) in a solid ring [rIn,rOut] at height y.
function ringGaps(solid: Set<string>, y: number, rIn: number, rOut: number): number {
  const N = 180;
  const occ: boolean[] = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TWO_PI;
    let any = false;
    for (let r = rIn; r <= rOut; r += 0.5) {
      const x = Math.round(r * Math.cos(a)), z = Math.round(r * Math.sin(a));
      if (solid.has(`${x},${y},${z}`)) { any = true; break; }
    }
    occ.push(any);
  }
  let gaps = 0;
  for (let i = 0; i < N; i++) if (!occ[i] && occ[(i - 1 + N) % N]) gaps++;
  return gaps;
}

// Fraction of the disc r<=rMax at height y that is floor material.
function discFloorFraction(floorSolid: Set<string>, y: number, rMax: number): number {
  let tot = 0, hit = 0;
  for (let x = -rMax; x <= rMax; x++) for (let z = -rMax; z <= rMax; z++) {
    if (Math.hypot(x, z) > rMax) continue;
    tot++;
    if (floorSolid.has(`${x},${y},${z}`)) hit++;
  }
  return hit / tot;
}

describe('BUILDING_TOWER stamp', () => {
  it('is a non-empty hollow shell with solid and carved-air voxels', () => {
    const { voxels } = tower(1);
    expect(voxels.length).toBeGreaterThan(0);
    expect(voxels.some((v) => v.weight > 0)).toBe(true);                       // walls / floors / ramp / roof
    expect(voxels.some((v) => v.material === 0 && v.weight < 0)).toBe(true);   // doorway + windows + interior
  });

  it('has an internal spiral ramp: floor-material voxels spanning many heights above the ground floor', () => {
    const rampLike = tower(1).voxels.filter((v) => v.weight > 0 && v.material === FLOOR_MATERIAL && v.y > 2);
    expect(rampLike.length).toBeGreaterThan(0);
    const distinctHeights = new Set(rampLike.map((v) => v.y));
    expect(distinctHeights.size).toBeGreaterThanOrEqual(11); // a spiral touches many heights, not 1-2 slabs
  });

  it.each([0, 2])('gives the ramp and landings walkable headroom in variant %i (regression: nothing may cap the ramp)', (variant) => {
    const { voxels } = tower(13, variant); // a 4-floor tower
    const solid = new Set<string>(), walkable = new Set<string>();
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
      if (y < 1 || solid.has(`${x},${y + 1},${z}`)) continue; // top surfaces only, skip ground slab
      const r = Math.hypot(x, z);
      const clear = clearanceAbove(x, y, z);
      if (r >= INNER_EDGE + 0.5 && r <= INTERIOR_R - 1.0) rampMin = Math.min(rampMin, clear);
      else if (r >= 1 && r <= INNER_EDGE - 0.5) centreMin = Math.min(centreMin, clear);
    }
    expect(rampMin).toBeGreaterThan(PLAYER_VOXELS);
    expect(centreMin).toBeGreaterThan(PLAYER_VOXELS);
  });

  it('has 4 windows around every floor', () => {
    const solid = solidSet(tower(13).voxels); // 4 floors, roofed
    // Measure the OUTER wall ring only (r 11-12): the window's inner edge (r=10) can coincide
    // with a spiral tread, and the door only reaches y<8, so higher floors give a clean count.
    for (const f of [1, 2, 3]) {
      const yC = 1 + f * FLOOR_HEIGHT + FLOOR_HEIGHT / 2;
      expect(ringGaps(solid, yC, RADIUS - 1, RADIUS)).toBe(4);
    }
  });

  it('completes the top floor as a full deck, not just a central landing', () => {
    const { voxels } = tower(13); // 4 floors, roofed
    const floor = new Set<string>();
    for (const v of voxels) if (v.weight > 0 && v.material === FLOOR_MATERIAL) floor.add(`${v.x},${v.y},${v.z}`);
    const topFloorY = 1 + 3 * FLOOR_HEIGHT;
    const lowerLandingY = 1 + 1 * FLOOR_HEIGHT;
    // The top deck fills most of the interior disc; a lower landing only fills the centre + a thin ramp arc.
    const topFill = discFloorFraction(floor, topFloorY - 1, INTERIOR_R);
    const lowerFill = discFloorFraction(floor, lowerLandingY - 1, INTERIOR_R);
    expect(topFill).toBeGreaterThan(0.5);
    expect(topFill).toBeGreaterThan(lowerFill * 1.5);
  });

  it('battlement variant (2): drops the roof for a shorter, crenellated top', () => {
    const roofed = tower(13, 0);
    const battle = tower(13, 2);
    // No conical roof -> the battlement is shorter than the roofed tower of the same seed.
    expect(maxYOf(battle.voxels)).toBeLessThan(maxYOf(roofed.voxels));
    // Crenellated parapet: the top ring alternates merlons (solid) and crenel gaps.
    const solid = solidSet(battle.voxels);
    const topY = maxYOf(battle.voxels);
    expect(ringGaps(solid, topY - 1, RADIUS - 1, RADIUS)).toBeGreaterThanOrEqual(4);
    // Still has windows on its lower floors.
    expect(ringGaps(solid, 1 + FLOOR_HEIGHT + FLOOR_HEIGHT / 2, RADIUS - 1, RADIUS)).toBe(4);
  });

  it('varies 2-4 floors tall with the seed', () => {
    const heights = new Set<number>();
    for (let seed = 0; seed < 40; seed++) {
      const maxY = maxYOf(tower(seed).voxels);
      heights.add(maxY);
      // radius 12 roofed -> roof apex ~ floors*12 + 15; floors in {2,3,4} => ~39..63
      expect(maxY).toBeGreaterThanOrEqual(34);
      expect(maxY).toBeLessThanOrEqual(68);
    }
    expect(heights.size).toBeGreaterThanOrEqual(2);
  });

  it('has a bounded, seed-independent X/Z footprint (only height changes with seed)', () => {
    const a = tower(1).bounds;
    const b = tower(999).bounds;
    for (const key of ['minX', 'maxX', 'minZ', 'maxZ'] as const) {
      expect(Math.abs(a[key])).toBeLessThanOrEqual(20); // radius 12 + margin 5 + rounding
      expect(a[key]).toBe(b[key]);                      // seed only changes floor count, not footprint
    }
  });
});
