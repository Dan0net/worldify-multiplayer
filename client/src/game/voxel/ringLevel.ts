/**
 * ringLevel — the pure distance→LOD-level schedule for Explore's concentric rings (Phase B).
 *
 * Explore assigns an LOD level to each region by its TRUE-WORLD distance from the stream centre, not one
 * global level (docs/lod-phase-b-concentric-rings.md §2). This module is that mapping and NOTHING else:
 * per the design (§5d) the `distance → level` rule is kept a single pure function so the ring schedule is
 * tunable (screen-space error, pitch-aware coarsening, per-device radii) WITHOUT touching the streaming /
 * swap machinery that consumes it.
 *
 *   Ring 0 (innermost): level `base` (the finest visible level; often 0).
 *   Each ring outward steps +1 level, clamped at MAX_ZOOM_LEVEL.
 *
 * Radii are in metres (level-independent), so a region's ring membership is a pure function of its world
 * position and the current centre + base — deterministic, no history.
 */

import { CHUNK_WORLD_SIZE, MAX_ZOOM_LEVEL, VISIBILITY_RADIUS } from '@worldify/shared';

/**
 * Thickness of each COARSE ring (level > base), counted in that ring's own level-L chunks. Kept "a few
 * chunks thick" so total resident geometry across all rings stays comparable to a single-level view
 * (docs §5c). Starting value — retuned per device in a later step (§6.5); the streaming machinery reads
 * only the metre radii below, so changing this never touches the swap code.
 */
export const RING_WIDTH_CHUNKS = 6;

/**
 * True-world radius (metres) of the innermost ring — the full-detail disk around the centre. Sized to the
 * normal visibility radius in level-`base` chunks so the near field is exactly as detailed as today's
 * single-level view before any coarser ring begins.
 */
function innerRingRadius(baseLevel: number): number {
  return VISIBILITY_RADIUS * (CHUNK_WORLD_SIZE * (1 << baseLevel));
}

/**
 * Outer radius (metres, exclusive) of the ring that renders at `level`, given the current `baseLevel`.
 * The innermost ring (level === base) spans `[0, innerRingRadius)`; each coarser ring adds
 * `RING_WIDTH_CHUNKS` chunks of its own (larger) level on top. Accumulating in metres keeps the boundary
 * a pure function of world position. `level` below `baseLevel` returns 0 (no ring finer than base exists).
 */
export function ringOuterRadius(level: number, baseLevel: number): number {
  if (level < baseLevel) return 0;
  let radius = innerRingRadius(baseLevel);
  for (let L = baseLevel + 1; L <= level; L++) {
    radius += RING_WIDTH_CHUNKS * (CHUNK_WORLD_SIZE * (1 << L));
  }
  return radius;
}

/**
 * LOD level for a region whose centre sits `distanceMeters` (true-world metres) from the stream centre,
 * with the current finest level `baseLevel`. Ring 0 = base within `innerRingRadius`; steps +1 per ring
 * outward; clamped to `[baseLevel, MAX_ZOOM_LEVEL]`. Beyond the last ring's outer radius everything is the
 * coarsest level (the far backdrop never goes un-levelled).
 */
export function ringLevel(distanceMeters: number, baseLevel: number): number {
  const base = Math.max(0, Math.min(MAX_ZOOM_LEVEL, baseLevel));
  for (let level = base; level < MAX_ZOOM_LEVEL; level++) {
    if (distanceMeters < ringOuterRadius(level, base)) return level;
  }
  return MAX_ZOOM_LEVEL;
}
