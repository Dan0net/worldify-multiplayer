/**
 * BiomeSpawnSampler — a pure, main-thread-usable replica of the generator's REGION (biome/river)
 * cellular field plus its landform continental base, used ONLY to pick a spawn location for a chosen
 * biome at world creation. It reproduces the exact noise construction in TerrainGenerator
 * (river/region field at seed+80000, landform warp+base at seed+50000), so `biomeIdAt` here matches the
 * generator (guarded by a drift test). It does NOT generate terrain — it just answers "which biome, and
 * is this on land?" for candidate cell centres so `SpawnManager` can target the right area.
 */
import FastNoiseLite from 'fastnoise-lite';
import { cellValueToBiomeId } from './Biome.js';
import { LANDFORM_BASE_FREQ, type TerrainLayerConfig } from './TerrainGenerator.js';

/** Land is where the warped continental base noise is above this (roughly above the beach band). */
const LAND_NOISE_THRESHOLD = 0.05;

export class BiomeSpawnSampler {
  private region: FastNoiseLite;
  private regionWarpX: FastNoiseLite;
  private regionWarpZ: FastNoiseLite;
  private regionWarpAmp: number;
  private lfWarpX: FastNoiseLite;
  private lfWarpZ: FastNoiseLite;
  private lfBase: FastNoiseLite;
  private lfWarpAmp: number;
  readonly biomeCount: number;
  readonly spacing: number;   // region cell size in meters (for the cell-enumeration step)

  constructor(seed: number, t: TerrainLayerConfig) {
    const m = t.masterScale > 0 ? t.masterScale : 1;
    const l = t.landScale > 0 ? t.landScale : 1;
    const sizeDiv = m * l;                                  // landSizeScale
    this.biomeCount = t.biomesEnabled && t.biomes ? t.biomes.length : 0;
    this.spacing = Math.max(1, t.riverSpacing) * sizeDiv;   // world-meters between region cells

    // Region (biome/river) field — matches the generator's river block (seed + 80000).
    this.region = new FastNoiseLite(seed + 80000);
    this.region.SetNoiseType(FastNoiseLite.NoiseType.Cellular);
    this.region.SetCellularReturnType(FastNoiseLite.CellularReturnType.CellValue);
    this.region.SetCellularDistanceFunction(FastNoiseLite.CellularDistanceFunction.EuclideanSq);
    this.region.SetFrequency((1 / Math.max(1, t.riverSpacing)) / sizeDiv);
    this.regionWarpX = new FastNoiseLite(seed + 80001);
    this.regionWarpX.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    this.regionWarpX.SetFractalOctaves(1);
    this.regionWarpX.SetFrequency(t.riverWarpFrequency / sizeDiv);
    this.regionWarpZ = new FastNoiseLite(seed + 80002);
    this.regionWarpZ.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    this.regionWarpZ.SetFractalOctaves(1);
    this.regionWarpZ.SetFrequency(t.riverWarpFrequency / sizeDiv);
    this.regionWarpAmp = t.riverWarpAmplitude * sizeDiv;

    // Landform base + warp — matches the generator's landform block (seed + 50000).
    const baseFreq = LANDFORM_BASE_FREQ * (t.landformScale > 0 ? t.landformScale : 1) / sizeDiv;
    this.lfWarpX = new FastNoiseLite(seed + 50000);
    this.lfWarpX.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    this.lfWarpX.SetFractalType(FastNoiseLite.FractalType.FBm);
    this.lfWarpX.SetFractalOctaves(2);
    this.lfWarpX.SetFrequency(baseFreq * (t.landformWarpScale > 0 ? t.landformWarpScale : 1));
    this.lfWarpZ = new FastNoiseLite(seed + 50001);
    this.lfWarpZ.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    this.lfWarpZ.SetFractalType(FastNoiseLite.FractalType.FBm);
    this.lfWarpZ.SetFractalOctaves(2);
    this.lfWarpZ.SetFrequency(baseFreq * (t.landformWarpScale > 0 ? t.landformWarpScale : 1));
    this.lfBase = new FastNoiseLite(seed + 50002);
    this.lfBase.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    this.lfBase.SetFractalType(FastNoiseLite.FractalType.FBm);
    this.lfBase.SetFractalOctaves(5);
    this.lfBase.SetFrequency(baseFreq);
    this.lfWarpAmp = t.landformWarpStrength * sizeDiv;
  }

  /** Biome index at a world position (matches TerrainGenerator.biomeIdAt). */
  biomeIdAt(x: number, z: number): number {
    if (this.biomeCount <= 0) return 0;
    const wx = x + this.regionWarpX.GetNoise(x, z) * this.regionWarpAmp;
    const wz = z + this.regionWarpZ.GetNoise(x, z) * this.regionWarpAmp;
    return cellValueToBiomeId(this.region.GetNoise(wx, wz), this.biomeCount);
  }

  /** Rough "is this column on land (above the beach)" test via the warped continental base noise sign. */
  isLand(x: number, z: number): boolean {
    const wx = x + this.lfWarpX.GetNoise(x, z) * this.lfWarpAmp;
    const wz = z + this.lfWarpZ.GetNoise(x, z) * this.lfWarpAmp;
    return this.lfBase.GetNoise(wx, wz) > LAND_NOISE_THRESHOLD;
  }

  /**
   * Find a spawn XZ for `biomeIndex` by enumerating cell centres outward from the origin (one eval per
   * cell on the region-spacing grid) and returning the nearest cell that is that biome AND on land.
   * Returns null if none found within `maxRings`. Pure + cheap (a few thousand noise evals, no terrain
   * generation) — reliably finds even a heavily down-weighted biome.
   */
  findSpawn(biomeIndex: number, maxRings = 96): { x: number; z: number } | null {
    if (this.biomeCount <= 0) return null;
    const s = this.spacing;
    let best: { x: number; z: number } | null = null;
    let bestD2 = Infinity;
    for (let ring = 0; ring <= maxRings; ring++) {
      // Scan the square ring at Chebyshev radius `ring`; stop early once a match is found in a ring
      // (the nearest is within this ring or the next, so finish this ring then return).
      for (let gz = -ring; gz <= ring; gz++) {
        for (let gx = -ring; gx <= ring; gx++) {
          if (ring > 0 && Math.max(Math.abs(gx), Math.abs(gz)) !== ring) continue; // ring shell only
          const x = (gx + 0.5) * s, z = (gz + 0.5) * s;   // cell centre
          if (this.biomeIdAt(x, z) !== biomeIndex || !this.isLand(x, z)) continue;
          const d2 = x * x + z * z;
          if (d2 < bestD2) { bestD2 = d2; best = { x, z }; }
        }
      }
      if (best) return best;   // nearest match found in this ring
    }
    return best;
  }
}
