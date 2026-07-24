/**
 * ringLevel — the pure distance→LOD-level schedule for Explore's concentric rings (Phase B).
 *
 * Explore assigns an LOD level to each region by its TRUE-WORLD distance from the stream centre
 * (docs/lod-phase-b-concentric-rings.md §2). This module is that mapping and NOTHING else — per the
 * design (§5d) the `distance → level` rule is a single pure function so the schedule is tunable without
 * touching the streaming/swap machinery that consumes it.
 *
 * The bands DOUBLE and are anchored to the visibility radius, so they are **base-independent**: level L
 * always occupies the true-world annulus `[R·2^(L-1), R·2^L)` where `R = visibilityRadius·CHUNK_WORLD_SIZE`.
 *   - The base disk (rendered at the finest level `base` by the base streamer) is `[0, R·2^base)`.
 *   - The first coarse ring (level base+1) is `[R·2^base, R·2^(base+1))` — flush against the disk edge.
 *   - Each coarser ring doubles outward.
 * Because a band's radius depends only on its own level (not on `base`), zooming (which changes `base`)
 * does NOT move the outer rings — only the base-disk boundary slides — so rings are retained across a
 * zoom instead of being wiped and regenerated. Effective level of a point = max(base, its band level).
 */

import { CHUNK_WORLD_SIZE, MAX_ZOOM_LEVEL, VISIBILITY_RADIUS } from '@worldify/shared';

/**
 * Outer true-world radius (metres, exclusive) of the LOD-`level` band: `visibilityRadius·CHUNK_WORLD_SIZE·2^level`.
 * Base-INDEPENDENT — depends only on `level` and the live `visibilityRadius` (quality-dependent, e.g. 7
 * on low / 11 on high). Level L's annulus is `[ringOuterRadius(L-1), ringOuterRadius(L))`; the base disk
 * (level = base) is `[0, ringOuterRadius(base))`, so the first coarse ring begins exactly at the disk edge.
 * Each ring is `visibilityRadius/2` chunks of its own level thick (the doubling makes that constant).
 */
export function ringOuterRadius(level: number, visibilityRadius = VISIBILITY_RADIUS): number {
  return visibilityRadius * CHUNK_WORLD_SIZE * (1 << Math.max(0, level));
}

/**
 * The world-space OUTER border (one axis, {lo, hi} in metres) of LOD `level`, centred on the camera and
 * QUANTISED TO THE LEVEL ABOVE (the level-`level+1` grid, cell size `CHUNK_WORLD_SIZE·2^(level+1)`).
 *
 * This is the seam between level `level` (inside) and level `level+1` (outside). Snapping it to the
 * COARSER level's grid means BOTH levels' cells land on it exactly (the coarse grid is a subset of the
 * fine grid), so the border always lines up with no gap or overlap — while each level stays centred on
 * the camera (no clipmap "whole view jumps in coarse steps"). Because it's snapped, the ring is not the
 * same width on every side — it's 1–2 of its own cells depending where the snap falls — which is exactly
 * the price of borders that always meet. Level `level`'s outer border == level `level+1`'s inner border,
 * both computed from this one function with the same args, so they are identical by construction.
 */
export function levelOuterBounds(
  level: number,
  center1D: number,
  visibilityRadius = VISIBILITY_RADIUS,
): { lo: number; hi: number } {
  const cw = CHUNK_WORLD_SIZE * (1 << Math.max(0, level));   // this level's chunk size (m)
  const up = cw * 2;                                          // the level-above grid we snap to
  const half = visibilityRadius * cw;                         // nominal half-extent (= ringOuterRadius(level))
  return {
    lo: Math.round((center1D - half) / up) * up,
    hi: Math.round((center1D + half) / up) * up,
  };
}

/**
 * LOD level for a region whose centre sits `distanceMeters` from the stream centre, given the finest
 * level `baseLevel` and the live `visibilityRadius`. Returns the finest band whose outer radius still
 * exceeds `distanceMeters`, floored at `baseLevel` and clamped to `[baseLevel, MAX_ZOOM_LEVEL]`. Because
 * the bands are base-independent, a point beyond the base disk keeps the same level as `base` changes —
 * that is what lets the rings persist across a zoom.
 */
export function ringLevel(distanceMeters: number, baseLevel: number, visibilityRadius = VISIBILITY_RADIUS): number {
  const base = Math.max(0, Math.min(MAX_ZOOM_LEVEL, baseLevel));
  for (let level = base; level < MAX_ZOOM_LEVEL; level++) {
    if (distanceMeters < ringOuterRadius(level, visibilityRadius)) return level;
  }
  return MAX_ZOOM_LEVEL;
}
