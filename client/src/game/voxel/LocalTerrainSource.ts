/**
 * LocalTerrainSource - client-side terrain generation for offline / local play.
 *
 * Mirrors the server's generation pipeline (ChunkProvider + MapTileProvider +
 * SurfaceColumnProvider) using the SAME shared `TerrainGenerator` and helpers,
 * so a local world is identical to a server world for a given seed. Produces the
 * exact network response shapes (VoxelChunkData / MapTileResponse /
 * SurfaceColumnResponse) so VoxelWorld can ingest them through its existing
 * receive* methods with no other changes.
 *
 * No persistence yet (a fresh world each session) — that is a later addition.
 */

import {
  TerrainGenerator,
  createMapTile,
  tilePixelIndex,
  updateTileFromChunk,
  chunkHasContent,
  scanMultiChunkColumn,
  getChunkRangeFromHeights,
  CHUNK_SIZE,
  VOXEL_SCALE,
  MAP_TILE_SIZE,
  type VoxelChunkData,
  type MapTileResponse,
  type SurfaceColumnResponse,
  type SurfaceColumnChunk,
  type CaveConfig,
  type TerrainLayerConfig,
} from '@worldify/shared';

/** Matches SurfaceColumnProvider on the server. */
const CHUNKS_BELOW_SURFACE = 0;
const MAX_CHUNKS_ABOVE = 4;

export class LocalTerrainSource {
  private readonly gen: TerrainGenerator;
  /** Cache raw generated chunk data so tile scanning and chunk requests agree. Packed integer key
   *  (±2^16 chunk range) — avoids a per-lookup string build + Map<string> hash on this hot path. */
  private readonly cache = new Map<number, Uint32Array>();

  constructor(seed: number, caveConfig?: CaveConfig, terrainConfig?: TerrainLayerConfig) {
    this.gen = new TerrainGenerator({
      seed,
      ...(caveConfig ? { caveConfig } : {}),
      ...(terrainConfig ? { terrainLayer: terrainConfig } : {}),
    });
  }

  private rawChunk(cx: number, cy: number, cz: number, level = 0): Uint32Array {
    // Pack (level,cx,cy,cz) into one safe-integer key. Coords ±2^15 (±262 km at level 0), level 0..15 —
    // the whole key is < 2^53, so distinct LOD levels never collide in the cache. No string alloc/hash.
    const key = ((level * 0x10000 + (cx + 0x8000)) * 0x10000 + (cy + 0x8000)) * 0x10000 + (cz + 0x8000);
    let data = this.cache.get(key);
    if (!data) {
      data = this.gen.generateChunk(cx, cy, cz, level);
      this.cache.set(key, data);
    }
    return data;
  }

  /** Fill a fresh tile with terrain-baseline surface heights/materials. At LOD level L the tile covers
   *  the same world region sampled at a 2^L step (coarse overview). */
  private baselineTile(tx: number, tz: number, level = 0) {
    const vs = VOXEL_SCALE * (1 << level);
    const tile = createMapTile(tx, tz);
    const worldX0 = tx * CHUNK_SIZE * vs;
    const worldZ0 = tz * CHUNK_SIZE * vs;
    for (let lz = 0; lz < MAP_TILE_SIZE; lz++) {
      for (let lx = 0; lx < MAP_TILE_SIZE; lx++) {
        const { height, material } = this.gen.sampleSurface(
          worldX0 + lx * vs,
          worldZ0 + lz * vs,
          level === 0,   // coarse LOD skips path/river furniture, matching generateChunk
        );
        const i = tilePixelIndex(lx, lz);
        tile.heights[i] = height;
        tile.materials[i] = material;
      }
    }
    return tile;
  }

  /** Generate a single chunk (equivalent of a server VOXEL_CHUNK_DATA response). `level` is the LOD
   *  zoom level (0 = full detail); a coarse chunk samples the same field at a 2^level step. */
  generateChunk(cx: number, cy: number, cz: number, level = 0): VoxelChunkData {
    return {
      chunkX: cx,
      chunkY: cy,
      chunkZ: cz,
      lastBuildSeq: 0,
      voxelData: this.rawChunk(cx, cy, cz, level),
    };
  }

  /**
   * Build the surface column for a tile: the surface chunks + a tile whose heights are corrected to
   * include stamps (tree canopies, buildings) that rise above the bare-terrain surface. Shared by
   * generateTile and generateColumn so BOTH report the true (stamp-inclusive) surface height — the
   * client's vertical load cap comes from these heights, so a terrain-only height would clip stamp
   * tops at the chunk boundary.
   */
  private buildSurfaceColumn(tx: number, tz: number, level = 0): { tile: ReturnType<typeof createMapTile>; chunks: SurfaceColumnChunk[] } {
    const tile = this.baselineTile(tx, tz, level);

    // Coarse LOD: pure base terrain (no stamps/caves), so the surface chunk range is just the height
    // span. A level-L chunk spans CHUNK_SIZE·2^L world-voxels vertically, so divide heights by that.
    if (level > 0) {
      const span = CHUNK_SIZE * (1 << level);
      let minH = Infinity, maxH = -Infinity;
      for (let i = 0; i < tile.heights.length; i++) {
        const h = tile.heights[i];
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
      const minCy = Math.floor(minH / span);
      const maxCy = Math.floor(maxH / span);
      const chunks: SurfaceColumnChunk[] = [];
      for (let cy = minCy; cy <= maxCy; cy++) {
        chunks.push({ chunkY: cy, lastBuildSeq: 0, voxelData: this.rawChunk(tx, cy, tz, level) });
      }
      return { tile, chunks };
    }

    const { minCy: terrainMinCy, maxCy: terrainMaxCy } = getChunkRangeFromHeights(tile.heights);
    const minCy = terrainMinCy - CHUNKS_BELOW_SURFACE;

    const chunks: SurfaceColumnChunk[] = [];
    const chunkDatas: Array<{ cy: number; data: Uint32Array }> = [];

    for (let cy = minCy; cy <= terrainMaxCy + MAX_CHUNKS_ABOVE; cy++) {
      const data = this.rawChunk(tx, cy, tz);
      const hasContent = chunkHasContent(data);
      // Always include terrain chunks; above terrain, include chunks with content (canopies,
      // buildings), stopping at the first empty chunk above the terrain top.
      if (cy <= terrainMaxCy || hasContent) {
        chunkDatas.push({ cy, data });
        chunks.push({ chunkY: cy, lastBuildSeq: 0, voxelData: data });
      }
      if (cy > terrainMaxCy && !hasContent) break;
    }

    // Correct the tile's surface heights to include stamps spanning chunks (canopy / building tops).
    for (const c of chunkDatas) {
      updateTileFromChunk(
        tile,
        { cx: tx, cy: c.cy, cz: tz, data: c.data },
        (lx, lz) => scanMultiChunkColumn(chunkDatas, lx, lz),
      );
    }

    return { tile, chunks };
  }

  /** Generate a tile with stamp-corrected surface heights (equivalent of a MAP_TILE_DATA response). */
  generateTile(tx: number, tz: number, level = 0): MapTileResponse {
    const { tile } = this.buildSurfaceColumn(tx, tz, level);
    return { tx, tz, heights: tile.heights, materials: tile.materials };
  }

  /**
   * Generate a bootstrap surface column: tile + the chunks that intersect the
   * surface. Mirrors SurfaceColumnProvider.generateColumn.
   */
  generateColumn(tx: number, tz: number, level = 0): SurfaceColumnResponse {
    const { tile, chunks } = this.buildSurfaceColumn(tx, tz, level);
    return { tx, tz, heights: tile.heights, materials: tile.materials, chunks };
  }
}
