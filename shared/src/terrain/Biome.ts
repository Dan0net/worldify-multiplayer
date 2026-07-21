/**
 * Biome / region model.
 *
 * The world is partitioned into biomes by a warped cellular field (the SAME field whose borders draw
 * rivers — cells = biomes, edges = rivers). Each biome is a cell whose stable per-cell hash maps to a
 * biome ID in 0..N-1 (N = palette length). Biomes ride ON TOP of the shared landform height: they
 * override the surface treatment (top material, detail amplitude, snow/rock thresholds, and which
 * stamps scatter), while sea/beach stay elevation-driven and the base height is global.
 */
import type { StampType } from './stamps/index.js';

export interface BiomeDefinition {
  /** Display name (used by the spawn selector + UI). */
  name: string;
  /** Surface ("grass/plains") material for this biome — e.g. moss for grassland, sand for desert. */
  topMaterial: number;
  /** Flat-ground surface-detail amplitude (voxels). */
  detailFlat: number;
  /** Steep-slope surface-detail amplitude (voxels). */
  detailSteep: number;
  /** Slope angle (degrees) above which the surface turns to rock. */
  rockSlopeDeg: number;
  /** Elevation above sea (voxels) above which the surface caps with snow (large = never). */
  snowLine: number;
  /** Stamp types allowed to scatter in this biome (a subset of the world stamp scatter). */
  stamps: StampType[];
}

/**
 * Map a warped cellular `CellValue` (FastNoiseLite, `closestHash / 2³¹`, in [-1,1)) to a biome ID in
 * 0..n-1. Recovers the exact int32 hash and takes it mod n — uniform over the palette and stable per
 * cell. Pure: the generator and the client (spawn selection) both call this so they agree.
 */
export function cellValueToBiomeId(cellValue: number, n: number): number {
  if (n <= 1) return 0;
  const hash = Math.round(cellValue * 2147483648); // 2³¹ — exact round-trip of the int32 hash
  return ((hash % n) + n) % n;
}
